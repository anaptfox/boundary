import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { portableSchema, validateSchemaValue, type JsonSchema, type JsonValue } from "@foxworth/boundary/program";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import { z } from "zod";

const vectors = JSON.parse(readFileSync(new URL("../conformance/v1/portable-collections.json", import.meta.url), "utf8")) as {
  version: number;
  cases: Array<{ name: string; schema: JsonSchema; values: Array<{ value: JsonValue; valid: boolean }> }>;
  invalid: JsonValue[];
  authoring: Array<{ name: string; contract: JsonSchema }>;
};

const byte = z.number().int().min(0).max(255);
const zodAuthoring: Record<string, z.ZodType> = {
  "byte-string-tuple": z.tuple([byte, z.string()]),
  "string-byte-record": z.record(z.string(), byte),
};

describe("reviewed portable tuple and record laws", () => {
  it.each(vectors.cases)("evaluates $name", vector => {
    expect(vectors.version).toBe(1);
    const schema = portableSchema(vector.schema);
    for (const sample of vector.values) {
      expect(validateSchemaValue(schema, sample.value).length === 0, JSON.stringify(sample.value)).toBe(sample.valid);
    }
  });

  it("refuses malformed collection keywords", () => {
    for (const schema of vectors.invalid) expect(() => portableSchema(schema as JsonSchema), JSON.stringify(schema)).toThrow();
  });

  it.each(vectors.authoring)("compiles Zod to the reviewed contract: $name", ({ name, contract }) => {
    const schema = zodAuthoring[name];
    expect(schema, name).toBeDefined();
    expect(compileZodSchema(schema!, "input", name).contract).toEqual(contract);
  });
});
