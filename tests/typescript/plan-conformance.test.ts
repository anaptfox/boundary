import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInteractionDescriptor, createProgram } from "../../packages/core/program/index.ts";
import { createPlan, planAggregateFootprints, planParallelWaves } from "../../packages/core/plan/index.ts";

type Vector = {
  version: 1;
  program: Array<{ id: string; reads: string[]; changes: string[] }>;
  valid: Array<{ name: string; plan: any; planDigest: string; aggregateFootprints: unknown; parallelWaves: string[][] }>;
  invalid: Array<{ name: string; reason: string; plan: any }>;
};

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../conformance/v1/plan.json", import.meta.url)), "utf8")) as Vector;
const schema = { type: "object", additionalProperties: false } as const;
const program = createProgram(vector.program.map(({ id, reads, changes }) => createInteractionDescriptor({
  contract: { version: 1, id, inputSchema: schema, outputSchema: schema, reads, changes },
})));

describe("shared Rust and TypeScript Plan v1 vectors", () => {
  it("agrees on plan digest, aggregate footprints, and parallel waves", () => {
    expect(vector.version).toBe(1);
    for (const item of vector.valid) {
      const plan = createPlan(item.plan);
      expect(plan.planDigest, item.name).toBe(item.planDigest);
      expect(planAggregateFootprints(plan, program), item.name).toEqual(item.aggregateFootprints);
      expect(planParallelWaves(plan, program), item.name).toEqual(item.parallelWaves);
    }
  });

  it("rejects every invalid plan", () => {
    for (const item of vector.invalid) expect(() => createPlan(item.plan), item.name).toThrow();
  });
});
