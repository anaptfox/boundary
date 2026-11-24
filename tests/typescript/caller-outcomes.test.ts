import { describe, expect, expectTypeOf, it } from "vitest";
import { createHost, defineInteraction, declaredInteractionError, bindProjection, compileInteractions, installInteractions, projectInteractions, admitAll, implementInteractions, type DirectOutcome, type ProjectionSelection, type RequestOutcome } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
import { unwrapOutcome } from "@foxworth/boundary";
import { createControlRequestContributions } from "@foxworth/boundary/host/control";

const Text = portableSchema<string>({ type: "string" });
const defs = { greet: defineInteraction({ id: "outcomes.greet", output: Text, errors: { unavailable: Text } }), fail: defineInteraction({ id: "outcomes.fail", output: Text }) } as const;

describe("native caller outcomes", () => {
  it("exposes direct, try, request and typed unwrap surfaces", async () => {
    const host = createHost(defs, {
      installationId: "outcomes:1", realizationVersion: "1",
      handlers: {
        greet(actor: string) { if (actor === "error") throw declaredInteractionError(defs.greet, "unavailable", "later"); return actor; },
        fail() { throw new Error("boom"); },
      },
      callers: { local: { direct: ["greet", "fail"], admit: actor => actor !== "deny" } },
    });
    const caller = host.bindings.local.connect();
    expectTypeOf(caller.try.greet("hello")).toEqualTypeOf<Promise<DirectOutcome<string, { unavailable: string }>>>();
    await expect(caller.direct.greet("hello")).resolves.toBe("hello");
    await expect(caller.try.greet("error")).resolves.toMatchObject({ kind: "declared-error", code: "unavailable", details: "later", certainty: "completed" });
    await expect(caller.try.greet("deny")).resolves.toMatchObject({ kind: "denied", certainty: "not-started" });
    await expect(caller.try.fail("actor")).resolves.toMatchObject({ kind: "fault", cause: "realization-failed", certainty: "unknown" });
    expect(unwrapOutcome({ kind: "ok", value: "yes", certainty: "completed" })).toBe("yes");
    expect(() => unwrapOutcome({ kind: "declared-error", code: "unavailable", details: "later", certainty: "completed" })).toThrow(expect.objectContaining({ name: "DeclaredInteractionError", code: "unavailable" }));
    for (const certainty of ["not-started", "not-completed", "unknown"] as const) {
      expect(() => unwrapOutcome({ kind: "fault", cause: "realization-failed", certainty, message: "failed" })).toThrow(expect.objectContaining({ certainty }));
    }
    host.bindingControllers.local.revoke();
    await expect(caller.try.greet("hello")).resolves.toMatchObject({ kind: "fault", cause: "revoked", certainty: "not-started" });
    expect(Object.isFrozen(caller.direct)).toBe(true);
    expect(host.tryCallers.local.greet).toBeTypeOf("function");
  });

  it("exposes request conveniences and typed request outcomes", async () => {
    const definitions = { ask: defineInteraction({ id: "outcomes.ask", output: Text }) } as const;
    const compiled = compileInteractions<typeof definitions>(definitions);
    const installed = installInteractions<typeof definitions, void>(compiled, {
      installationId: "outcomes:request", implementations: implementInteractions(definitions, { ask: () => "unused" }),
      realizationIds: { ask: { direct: "ask:direct", request: "ask:request" } },
      requests: createControlRequestContributions(compiled, { ask: { interaction: compiled.handles.ask, controlDigest: compiled.handles.ask.contractDigest, previewSchema: Text, request: () => "proposal" } }),
    });
    type Selected = { readonly ask: ProjectionSelection<typeof compiled.handles.ask, readonly ["request"]> };
    const projection = projectInteractions<typeof definitions, Selected>(compiled, { ask: { interaction: compiled.handles.ask, modes: ["request"] } });
    const bound = bindProjection<Selected, void>(projection, installed.installation, { admit: admitAll });
    if (bound.status !== "bound") throw new Error("binding failed");
    const caller = bound.binding.connect();
    expectTypeOf(projection.handles.ask.inputArity).toEqualTypeOf<0>();
    caller.request(projection.handles.ask);
    expectTypeOf<Promise<RequestOutcome<import("@foxworth/boundary/program").JsonValue>>>(caller.tryRequest.ask()).toEqualTypeOf<Promise<RequestOutcome<import("@foxworth/boundary/program").JsonValue>>>();
    await expect(caller.requests.ask()).resolves.toBe("proposal");
    await expect(caller.tryRequest.ask()).resolves.toEqual({ kind: "ok", proposal: "proposal", certainty: "completed" });
  });
});
