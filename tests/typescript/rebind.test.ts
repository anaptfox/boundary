import { describe, expect, it } from "vitest";
import { admitAll, bindProjection, compileInteractions, createBindingSlot, defineInteraction, installInteractions, projectInteractions, realizeDirect, rebindProjection } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Result = portableSchema<{ ok: true }>({ type: "object", properties: { ok: { const: true } }, required: ["ok"], additionalProperties: false });

describe("explicit binding rebind", () => {
  it("preserves an active binding when the next installation is unrealized, then swaps atomically", () => {
    const definitions = { run: defineInteraction({ id: "rebind.run", output: Result }) } as const;
    const compiled = compileInteractions(definitions);
    const projection = projectInteractions(compiled, { run: { interaction: compiled.handles.run, modes: ["direct"] } });
    const first = installInteractions(compiled, { installationId: "rebind:first", realizations: { run: realizeDirect(() => ({ ok: true }), "rebind:first:run") } });
    const initial = bindProjection(projection, first.installation, { admit: admitAll });
    if (initial.status !== "bound") throw new Error("expected initial binding");
    const slot = createBindingSlot(projection, initial);
    const second = installInteractions(compiled, { installationId: "rebind:second", realizations: {} });
    expect(slot.rebind(second.installation, { admit: admitAll }).status).toBe("unrealized");
    expect(slot.revoked).toBe(false);
    const third = installInteractions(compiled, { installationId: "rebind:third", realizations: { run: realizeDirect(() => ({ ok: true }), "rebind:third:run") } });
    expect(slot.rebind(third.installation, { admit: admitAll }).status).toBe("rebound");
    expect(slot.revoked).toBe(false);
    expect(initial.controller.revoked).toBe(true);
    const standalone = rebindProjection({ projection, previousBinding: slot.current, previousController: { revoked: false, revoke: () => true }, nextInstallation: third.installation, admit: admitAll });
    expect(standalone.status).toBe("rebound");
  });
});
