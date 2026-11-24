import { describe, expect, it } from "vitest";
import { b } from "../../packages/core/program/schema-builder";
import { bindProjection, compileInteractions, defineInteraction, directRealizationIds, implementInteractions, installInteractions } from "@foxworth/boundary";
import { createPlan, planAggregateFootprints, planParallelWaves, planRequiredProjection, planRequiredSelections, preflightPlan, validatePlan, type Plan } from "@foxworth/boundary/plan";
import type { ProjectionBindingManifest } from "../../packages/core/program/artifacts";
import type { Sha256Digest } from "../../packages/core/program/json";

const definitions = {
  reader: defineInteraction({ id: "data.read", output: b.json(), reads: ["alpha", "shared"], changes: [] }),
  otherReader: defineInteraction({ id: "data.other", output: b.json(), reads: ["alpha"], changes: [] }),
  writer: defineInteraction({ id: "data.write", output: b.json(), reads: ["alpha"], changes: ["alpha"] }),
  writer2: defineInteraction({ id: "data.write2", output: b.json(), reads: [], changes: ["alpha"] }),
};
const compiled = compileInteractions(definitions);
const program = compiled.program;
const plan = (steps: readonly any[]) => createPlan({ id: "example", steps });
const step = (id: string, alias: string, interactionId: string, mode: "direct" | "request" = "direct", extra: Record<string, unknown> = {}) => ({ id, alias, interactionId, mode, ...extra });
const digest = (char: string) => `sha256:${char.repeat(64)}` as Sha256Digest;
const manifestFor = (planValue: Plan, options: { omit?: string; mode?: string; aliasInteraction?: string; actualProgram?: typeof program } = {}): ProjectionBindingManifest => {
  const interactions = planValue.steps.filter((s) => s.id !== options.omit).map((s, index) => ({
    alias: s.alias,
    interactionId: index === 0 && options.aliasInteraction ? options.aliasInteraction : s.interactionId,
    expectedContractDigest: digest("a"),
    actualContractDigest: digest("b"),
    inputArity: 0 as const,
    mode: index === 0 && options.mode ? options.mode as "direct" | "request" : s.mode,
    realizationId: `realization-${index}`,
  }));
  const actualProgram = options.actualProgram ?? program;
  return { version: 1, bindingDigest: digest("c"), projectionDigest: digest("d"), installationId: "installation", installationDigest: digest("e"), expectedProgramDigest: program.programDigest, actualProgramDigest: actualProgram.programDigest, expectedProgram: program, actualProgram, actualCatalog: {} as any, interactions };
};

describe("handler-free Plan algebra", () => {
  it("normalizes dependencies, hashes synchronously, freezes deeply, and validates round trips", () => {
    const source = { id: "stable", steps: [step("a", "reader", "data.read", "direct", { dependsOn: ["z", "z", "b"], inputs: { lit: { kind: "literal", value: { deep: [1, 2] } } } }), step("b", "otherReader", "data.other"), step("z", "writer", "data.write")] };
    const first = createPlan(source), second = createPlan(source);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.steps[0]!.dependsOn).toEqual(["b", "z"]);
    const literal = first.steps[0]!.inputs.lit!;
    expect(literal.kind === "literal" && Object.isFrozen(literal.value)).toBe(true);
    expect(validatePlan(first)).toEqual(first);
  });

  it("rejects invalid DAG references, duplicates, cycles, self edges, and alias conflicts", () => {
    expect(() => plan([step("a", "x", "data.read", "direct", { dependsOn: ["a"] })])).toThrow(expect.objectContaining({ code: "CYCLE_DETECTED" }));
    expect(() => plan([step("a", "x", "data.read", "direct", { dependsOn: ["missing"] })])).toThrow(expect.objectContaining({ code: "UNKNOWN_STEP" }));
    expect(() => plan([step("a", "x", "data.read", "direct", { inputs: { value: { kind: "step-output", stepId: "missing" } } })])).toThrow(expect.objectContaining({ code: "UNKNOWN_STEP" }));
    expect(() => plan([step("a", "x", "data.read", "direct", { dependsOn: ["b"] }), step("b", "y", "data.other", "direct", { dependsOn: ["a"] })])).toThrow(expect.objectContaining({ code: "CYCLE_DETECTED" }));
    expect(() => plan([step("a", "x", "data.read"), step("a", "x", "data.read")])).toThrow(expect.objectContaining({ code: "DUPLICATE_STEP_ID" }));
    expect(() => plan([step("a", "x", "data.read"), step("b", "x", "data.other")])).toThrow(expect.objectContaining({ code: "ALIAS_CONFLICT" }));
    expect(() => plan([step("a", "x", "data.read"), step("b", "y", "data.read")])).toThrow(expect.objectContaining({ code: "ALIAS_CONFLICT" }));
  });

  it("aggregates unique UTF-8 sorted footprints and rejects unknown Program interactions", () => {
    const value = plan([step("a", "reader", "data.read"), step("b", "writer", "data.write")]);
    expect(planAggregateFootprints(value, program)).toEqual({ reads: ["alpha", "shared"], changes: ["alpha"] });
    expect(() => planAggregateFootprints(value, { ...program, interactions: [] })).toThrow(expect.objectContaining({ code: "MISSING_INTERACTION" }));
  });

  it("places read-only peers together and serializes hazards, dependencies, and output wiring", () => {
    const reads = plan([step("r1", "reader", "data.read"), step("r2", "otherReader", "data.other")]);
    expect(planParallelWaves(reads, program)).toEqual([["r1", "r2"]]);
    const hazards = plan([step("r", "reader", "data.read"), step("w", "writer", "data.write"), step("w2", "writer2", "data.write2")]);
    expect(planParallelWaves(hazards, program)).toEqual([["r"], ["w"], ["w2"]]);
    const explicit = plan([step("later", "writer", "data.write", "direct", { dependsOn: ["first"] }), step("first", "reader", "data.read")]);
    expect(planParallelWaves(explicit, program)).toEqual([["first"], ["later"]]);
    const wired = plan([step("consume", "writer", "data.write", "direct", { inputs: { payload: { kind: "step-output", stepId: "produce", path: "value" } } }), step("produce", "reader", "data.read")]);
    expect(planParallelWaves(wired, program)).toEqual([["produce"], ["consume"]]);
  });

  it("derives minimal selections and projection, merging both modes", () => {
    const value = plan([step("a", "reader", "data.read"), step("b", "reader", "data.read", "request"), step("c", "otherReader", "data.other", "request")]);
    expect(planRequiredSelections(value, program)).toEqual({ reader: { interactionId: "data.read", modes: ["direct", "request"] }, otherReader: { interactionId: "data.other", modes: ["request"] } });
    const projection = planRequiredProjection(value, compiled);
    expect(projection.interactions).toHaveLength(2);
    expect(projection.interactions.find((entry) => entry.alias === "reader")?.modes).toEqual(["direct", "request"]);
  });

  it("binds a derived direct projection to a matching installation", () => {
    const value = plan([step("a", "reader", "data.read")]);
    const projection = planRequiredProjection(value, compiled);
    const installed = installInteractions(compiled, {
      installationId: "plan-test-installation",
      implementations: implementInteractions(definitions, {
        reader: () => null, otherReader: () => null, writer: () => null, writer2: () => null,
      }),
      realizationIds: directRealizationIds(compiled, "plan-test"),
    });
    expect(bindProjection(projection, installed.installation, { admit: () => ({ decision: "allow" }) }).status).toBe("bound");
  });

  it("preflights every step and reports missing or wrong modes before execution", () => {
    const value = plan([step("1", "reader", "data.read"), step("2", "otherReader", "data.other"), step("3", "writer", "data.write"), step("4", "writer2", "data.write2")]);
    expect(preflightPlan(value, manifestFor(value), program)).toMatchObject({ ready: true, issues: [] });
    const missing = preflightPlan(value, manifestFor(value, { omit: "4" }), program);
    expect(missing.ready).toBe(false);
    expect(missing.issues).toMatchObject([{ stepId: "4", reason: "missing-interaction" }]);
    const wrongMode = preflightPlan(value, manifestFor(value, { mode: "request" }), program);
    expect(wrongMode.ready).toBe(false);
    expect(wrongMode.issues).toMatchObject([{ stepId: "1", reason: "mode-not-bound" }]);
    expect(preflightPlan(value, manifestFor(value, { aliasInteraction: "data.other" }), program).issues).toMatchObject([{ reason: "alias-mismatch" }]);
    const widened = compileInteractions({
      reader: defineInteraction({ id: "data.read", output: b.json(), reads: ["alpha", "shared"], changes: ["unplanned"] }),
      otherReader: definitions.otherReader, writer: definitions.writer, writer2: definitions.writer2,
    }).program;
    expect(preflightPlan(value, manifestFor(value, { actualProgram: widened }), program).issues).toMatchObject([{ stepId: "1", reason: "contract-mismatch" }]);
  });
});
