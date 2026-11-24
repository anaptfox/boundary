import { describe, expect, it } from "vitest";
import { compileInteractions, defineInteraction, projectInteractions, unionProjections, intersectProjections, omitProjection } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Result = portableSchema<{ ok: true }>({ type: "object", properties: { ok: { const: true } }, required: ["ok"], additionalProperties: false });

describe("Projection set algebra", () => {
  it("rebuilds closed projections and has order-independent union identity", () => {
    const definitions = { run: defineInteraction({ id: "algebra.run", output: Result }) } as const;
    const a = compileInteractions(definitions), b = compileInteractions(definitions);
    const direct = projectInteractions(a, { run: { interaction: a.handles.run, modes: ["direct"] } });
    const request = projectInteractions(b, { run: { interaction: b.handles.run, modes: ["request"] } });
    const union = unionProjections(direct, request);
    expect(union.projectionDigest).toBe(unionProjections(request, direct).projectionDigest);
    expect(union.handles.run.modes).toEqual(["direct", "request"]);
    expect(union.manifest.program.interactions).toHaveLength(1);
    expect(union.omit("algebra.run").manifest.interactions).toHaveLength(0);
    expect(intersectProjections(direct, request).manifest.interactions).toHaveLength(0);
  });
  it("chooses a deterministic authentic descriptor across equivalent compilations", () => {
    const leftCompiled = compileInteractions({ run: defineInteraction({ id: "algebra.docs", output: Result, description: "Left docs" }) });
    const rightCompiled = compileInteractions({ run: defineInteraction({ id: "algebra.docs", output: Result, description: "Right docs" }) });
    const left = projectInteractions(leftCompiled, { run: { interaction: leftCompiled.handles.run, modes: ["direct"] } });
    const right = projectInteractions(rightCompiled, { run: { interaction: rightCompiled.handles.run, modes: ["request"] } });
    expect(unionProjections(left, right).projectionDigest).toBe(unionProjections(right, left).projectionDigest);
  });
  it("rejects duplicate and unknown keys", () => {
    const compiled = compileInteractions({ run: defineInteraction({ id: "algebra.run", output: Result }) });
    const projection = projectInteractions(compiled, { run: { interaction: compiled.handles.run, modes: ["direct"] } });
    expect(() => omitProjection(projection, "run", "algebra.run")).toThrow(expect.objectContaining({ code: "INVALID_PROJECTION" }));
    expect(() => projection.pick("absent")).toThrow(expect.objectContaining({ code: "INVALID_PROJECTION" }));
  });
});
