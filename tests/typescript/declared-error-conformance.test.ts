import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindProjection, compileInteractions, defineInteraction, direct, directRealizationIds,
  implementInteractions, installInteractions, projectInteractions,
} from "@foxworth/boundary";
import { createHandoffInvocation, executeHandoff, validateHandoffOutcome, validateHandoffResponse } from "@foxworth/boundary/handoff";
import { createProjectionClient } from "@foxworth/boundary/client";
import { portableSchema, validateSchemaValue, type JsonSchema, type JsonValue } from "@foxworth/boundary/program";

const evidence = JSON.parse(readFileSync(new URL("../conformance/v1/declared-errors.json", import.meta.url), "utf8")) as {
  schema: JsonSchema;
  cases: Array<{ name: string; value: Record<string, JsonValue>; accepted: boolean }>;
};
const details = (field: string) => portableSchema({ type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false });
const definitions = {
  probe: defineInteraction({ id: "errors.probe", input: portableSchema<string>({ type: "string" }),
    output: portableSchema<string>({ type: "string" }), reads: ["probe"], changes: ["probe"],
    errors: { not_found: details("id"), unavailable: details("reason") } }),
};
async function fixture() {
  const compiled = compileInteractions(definitions);
  const { installation } = installInteractions(compiled, { installationId: "errors/reviewed/v1",
    implementations: implementInteractions(definitions, { probe: value => value }),
    realizationIds: directRealizationIds(compiled, "v1") });
  const projection = projectInteractions(compiled, { probe: direct(compiled.handles.probe) });
  const bound = bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
  if (bound.status !== "bound") throw new Error("reviewed error fixture did not bind");
  const invocation = await createHandoffInvocation(bound.binding.manifest, "errors.probe", "direct", "probe");
  const outcome = await executeHandoff(bound.binding, invocation, undefined);
  return { compiled, binding: bound.binding, invocation, outcome };
}

describe("reviewed complete declared-error values", () => {
  it("compiles the independently authored code-specific schema", async () => {
    const f = await fixture();
    expect(f.compiled.program.interactions[0]!.contract.errorSchema).toEqual(evidence.schema);
  });
  for (const vector of evidence.cases) {
    it(`${vector.accepted ? "preserves" : "rejects"} ${vector.name}`, async () => {
      const f = await fixture();
      expect(validateSchemaValue(evidence.schema, vector.value).length === 0).toBe(vector.accepted);
      const result = { kind: "declared-error", ...vector.value };
      const response = { ...f.outcome, result };
      const checked = validateHandoffResponse(f.binding.manifest, f.invocation, response);
      if (vector.accepted) await expect(checked).resolves.toMatchObject({ certainty: "completed", result });
      else await expect(checked).rejects.toThrow();
      let calls = 0;
      const client = createProjectionClient({ inspect: async () => f.binding.manifest,
        invoke: async () => { calls++; return validateHandoffOutcome(response); } });
      const call = client.callRaw("errors.probe", "probe");
      if (vector.accepted) await expect(call).rejects.toMatchObject({ value: vector.value });
      else await expect(call).rejects.toMatchObject({ certainty: "unknown" });
      expect(calls).toBe(1);
    });
  }
});
