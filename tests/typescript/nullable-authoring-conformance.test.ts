import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractChanges, contractCompatibility, digestInteractionContract, portableSchema, validateSchemaValue, type InteractionContract, type JsonSchema, type JsonValue } from "@foxworth/boundary/program";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import { z } from "zod";

const vectors = JSON.parse(readFileSync(new URL("../conformance/v1/nullable-authoring.json", import.meta.url), "utf8")) as {
  version: number;
  cases: Array<{ name: string; schema: JsonSchema; values: Array<{ value: JsonValue; valid: boolean }> }>;
  unsupported: JsonSchema[];
  migration: { before: InteractionContract; beforeDigest: string; after: InteractionContract; afterDigest: string; existingCallers: boolean; reverse: boolean };
};

describe("reviewed nullable authoring laws", () => {
  it.each(vectors.cases)("preserves assertions: $name", vector => {
    expect(vectors.version).toBe(1);
    const schema = portableSchema(vector.schema);
    for (const sample of vector.values) expect(validateSchemaValue(schema, sample.value).length === 0, JSON.stringify(sample.value)).toBe(sample.valid);
  });
  it("retains the strict portable profile instead of adding type arrays", () => {
    for (const schema of vectors.unsupported) expect(() => portableSchema(schema)).toThrow();
  });
  it("pins the old and new declarations and reports deliberate directional migration", async () => {
    const { before, after, beforeDigest, afterDigest, existingCallers, reverse } = vectors.migration;
    expect(compileZodSchema(z.string(), "input", "before").contract).toEqual(before.inputSchema);
    expect(compileZodSchema(z.string().nullable(), "input", "after").contract).toEqual(after.inputSchema);
    expect(await digestInteractionContract(before)).toBe(beforeDigest);
    expect(await digestInteractionContract(after)).toBe(afterDigest);
    const delta = contractChanges(before, after);
    expect(delta.changes).toEqual([
      { path: "inputSchema.anyOf", kind: "added", after: [{ type: "string" }, { type: "null" }] },
      { path: "inputSchema.type", kind: "removed", before: "string" },
    ]);
    expect(delta.existingCallers.compatible).toBe(existingCallers);
    expect(contractCompatibility(after, before).compatible).toBe(reverse);
  });
});
