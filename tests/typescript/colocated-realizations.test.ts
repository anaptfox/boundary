import { describe, expect, it } from "vitest";
import { compileInteractions, defineInteraction, installInteractions, projectInteractions, bindProjection, admitAll, realizeDirect } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Result = portableSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false });

describe("co-located realizations", () => {
  it("installs direct handlers with their identities beside each handler", async () => {
    const definitions = { get: defineInteraction({ id: "colocated.get", output: Result }) } as const;
    const compiled = compileInteractions(definitions);
    const { installation } = installInteractions(compiled, {
      installationId: "colocated:one",
      realizations: { get: realizeDirect(() => ({ value: "ready" }), "colocated:get:v1") },
    });
    const projection = projectInteractions(compiled, { get: { interaction: compiled.handles.get, modes: ["direct"] } });
    const result = bindProjection(projection, installation, { admit: admitAll });
    if (result.status !== "bound") throw new Error("expected a bound projection");
    await expect(result.binding.connect().call(projection.handles.get)).resolves.toEqual({ value: "ready" });
  });
});
