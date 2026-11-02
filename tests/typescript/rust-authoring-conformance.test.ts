import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileInteractions } from "@foxworth/boundary/pipeline";
import { defineInteraction } from "@foxworth/boundary";
import { canonicalJson, type JsonSchema } from "@foxworth/boundary/program";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import { z } from "zod";

const vectors = JSON.parse(readFileSync(new URL("../conformance/v1/rust-authoring.json", import.meta.url), "utf8")) as {
  version: number;
  patterns: Record<"uuid" | "email", string>;
  parity: Array<{ name: string; contract: JsonSchema; digest: string }>;
  declaredErrors: Array<{ name: string; errorSchema: JsonSchema; digest: string }>;
  rejected: Array<{ name: string }>;
};

const byte = z.number().int().min(0).max(255);
const zodAuthoring: Record<string, z.ZodType> = {
  "strict-object": z.strictObject({ id: z.string(), count: byte }),
  "optional-nullable": z.strictObject({ note: z.string().nullish() }),
  catchall: z.object({ x: byte }).catchall(byte),
  "tagged-union": z.discriminatedUnion("t", [
    z.strictObject({ t: z.literal("U") }),
    z.strictObject({ t: z.literal("S"), x: byte }),
  ]),
  "untagged-union": z.union([byte, z.string(), z.strictObject({ x: byte })]),
  "uuid-email": z.strictObject({ id: z.uuid(), e: z.email() }),
};
const zodRejected: Record<string, z.ZodType> = {
  "open-object": z.object({ a: z.string() }),
  "open-enum-variant": z.discriminatedUnion("t", [z.object({ t: z.literal("S"), x: byte })]),
  "flatten-struct": z.object({ a: z.string() }).and(z.object({ b: z.string() })),
};

const zodErrors: Record<string, Record<string, z.ZodType>> = {
  "payload-and-unit": {
    item_not_found: z.strictObject({ id: z.string() }),
    item_conflict: z.strictObject({ expected: byte, actual: byte }),
    item_gone: z.null(),
  },
  "single-code": { item_gone: z.strictObject({ id: z.string() }) },
};

describe("Zod and Rust author the same contracts", () => {
  it.each(vectors.parity)("compiles Zod to the reviewed contract and digest: $name", ({ name, contract, digest }) => {
    expect(vectors.version).toBe(1);
    const schema = zodAuthoring[name];
    expect(schema, name).toBeDefined();
    const compiled = compileZodSchema(schema!, "input", name).contract;
    expect(compiled).toEqual(contract);
    const hash = createHash("sha256").update(canonicalJson(compiled as never)).digest("hex");
    expect(`sha256:${hash}`).toBe(digest);
  });

  it.each(vectors.declaredErrors)("builds the reviewed errorSchema from declared errors: $name", async ({ name, errorSchema, digest }) => {
    const errors = zodErrors[name];
    expect(errors, name).toBeDefined();
    const definitions = { probe: defineInteraction({ id: "errors.probe", input: z.string(), output: z.string(), reads: ["p"], changes: [], errors: errors! }) };
    const compiled = await compileInteractions(definitions);
    const built = compiled.program.interactions[0]!.contract.errorSchema;
    expect(built).toEqual(errorSchema);
    const hash = createHash("sha256").update(canonicalJson(built as never)).digest("hex");
    expect(`sha256:${hash}`).toBe(digest);
  });

  it("emits the pinned uuid and email patterns", () => {
    const pattern = (schema: z.ZodType) => (compileZodSchema(schema, "input", "p").contract as { pattern?: string }).pattern;
    expect(pattern(z.uuid())).toBe(vectors.patterns.uuid);
    expect(pattern(z.email())).toBe(vectors.patterns.email);
  });

  it.each(vectors.rejected)("refuses the open shape: $name", ({ name }) => {
    const schema = zodRejected[name];
    expect(schema, name).toBeDefined();
    expect(() => compileZodSchema(schema!, "input", name)).toThrow();
  });
});
