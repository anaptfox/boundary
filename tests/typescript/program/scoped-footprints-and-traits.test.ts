import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileInteractions, defineInteraction } from "../../../packages/core/host/index";
import {
  canonicalJson,
  contractCompatibility,
  contractChanges,
  createInteractionDescriptor,
  digestInteractionContract,
  footprintSubsumes,
  ProgramError,
  b,
  resolveFootprints,
  scopedObservationFootprints,
  validateFootprint,
  type InteractionContract,
  type JsonValue,
} from "../../../packages/core/program/index";

const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../conformance/v1/${name}.json`, import.meta.url)), "utf8")) as any;
const base: InteractionContract = { version: 1, id: "items.write", inputSchema: { type: "object" }, outputSchema: { type: "object" }, reads: [], changes: [] };

describe("scoped footprints and declared contract traits", () => {
  it("validates scoped footprint conformance vectors", () => {
    const vectors = read("scoped-footprints");
    for (const value of vectors.valid) expect(validateFootprint(value)).toBe(value);
    for (const value of vectors.invalid) expect(() => validateFootprint(value)).toThrow(ProgramError);
    for (const test of vectors.subsumption) expect(footprintSubsumes(test.expected, test.offered), test.expected).toBe(test.subsumes);
    for (const test of vectors.resolution) expect(resolveFootprints(test.templates, test.input as JsonValue)).toEqual(test.expectedResolved);
    expect(scopedObservationFootprints(["docs:{input.id}"], [], { id: "d1" })).toEqual({ scopedReads: ["docs:d1"] });
  });

  it("matches shared trait identity digests and directional compatibility vectors", () => {
    const vectors = read("contract-traits");
    for (const test of vectors.digests) {
      const descriptor = createInteractionDescriptor({ contract: test.contract });
      expect(canonicalJson(descriptor.contract)).toBe(test.canonical);
      expect(digestInteractionContract(descriptor.contract)).toBe(test.digest);
    }
    for (const test of vectors.compatibility) {
      expect(contractCompatibility({ ...base, ...test.expected }, { ...base, ...test.offered }).compatible, test.name).toBe(test.compatible);
    }
    expect(() => createInteractionDescriptor({ contract: { ...base, idempotencyKey: "bad key" } })).toThrow(ProgramError);
    expect(() => createInteractionDescriptor({ contract: { ...base, compensates: base.id } })).toThrow(ProgramError);
    expect(contractChanges(base, { ...base, idempotencyKey: "request.id" }).changes).toContainEqual(expect.objectContaining({ path: "idempotencyKey", kind: "added" }));
  });

  it("compiles authored traits into contract identity", () => {
    const interaction = defineInteraction({
      id: "items.write",
      input: b.object({ id: b.string() }),
      output: b.object({ ok: b.boolean() }),
      reads: ["items:{input.id}"],
      changes: ["items:{input.id}"],
      idempotencyKey: "request.id",
      compensates: "items.restore",
    });
    const compiled = compileInteractions({ write: interaction });
    expect(compiled.program.interactions[0]?.contract).toMatchObject({
      idempotencyKey: "request.id",
      compensates: "items.restore",
      reads: ["items:{input.id}"],
    });
  });
});
