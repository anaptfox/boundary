import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileZodSchema } from "@foxworth/boundary/program/zod";
import { contractCompatibility, digestInteractionContract, validateSchemaValue } from "@foxworth/boundary/program";

describe("Zod nullable authoring", () => {
  it.each([z.string(), z.boolean(), z.number()])("lowers generated nullable type arrays", (inner) => {
    const schema = inner.nullable();
    const compiled = compileZodSchema(schema, "input", "nullable.input");
    expect(compiled.contract).toEqual({ anyOf: [{ type: inner._zod.def.type }, { type: "null" }] });
    for (const value of [null, "hello", true, 3, {}, []]) {
      expect(validateSchemaValue(compiled.contract, value).length === 0).toBe(schema.validate(value));
    }
  });

  it("keeps property annotations separate from the lowered contract", () => {
    const compiled = compileZodSchema(z.strictObject({
      label: z.string().nullable().meta({ description: "Optional label", control: "line" }),
    }), "input", "nullable.input");
    expect(compiled.contract.properties).toEqual({ label: { anyOf: [{ type: "string" }, { type: "null" }] } });
    expect(compiled.annotations).toEqual({ properties: { label: { description: "Optional label", control: "line" } } });
  });

  it("keeps bounds, nested schemas, and deliberate contract identity changes", async () => {
    const inner = z.string().min(2).max(5).regex(/^[a-z]+$/u);
    const schema = z.strictObject({ label: inner.nullable(), list: z.array(z.number().int().min(1).max(3)).min(1).max(2).nullable() });
    const compiled = compileZodSchema(schema, "input", "nullable.input");
    for (const value of [
      { label: null, list: null }, { label: "ab", list: [1, 3] },
      { label: "a", list: [1] }, { label: "abcdef", list: [1] },
      { label: "AB", list: [1] }, { label: "ab", list: [] },
      { label: "ab", list: [4] }, { label: "ab", list: [1.5] },
    ]) expect(validateSchemaValue(compiled.contract, value).length === 0).toBe(schema.validate(value));
    const before = { version: 1 as const, id: "labels.write", inputSchema: compileZodSchema(inner, "input", "before").contract, outputSchema: {}, reads: [], changes: ["labels"] };
    const after = { ...before, inputSchema: compileZodSchema(inner.nullable(), "input", "after").contract };
    expect(await digestInteractionContract(after)).not.toBe(await digestInteractionContract(before));
    expect(contractCompatibility(before, after).compatible).toBe(true);
    expect(contractCompatibility(after, before).compatible).toBe(false);
  });

  it("does not make transformations or unsupported formats portable", () => {
    for (const schema of [z.string().trim().nullable(), z.url().nullable()]) {
      expect(() => compileZodSchema(schema, "input", "nullable.input")).toThrow();
    }
  });
  it("rejects malformed generated type arrays without dropping sibling assertions", () => {
    for (const type of [[], ["string", "string"], ["string", "mystery"], ["string", 1]]) {
      expect(() => compileZodSchema(z.string().meta({ type }), "input", "nullable.input")).toThrow();
    }
    expect(() => compileZodSchema(z.string().meta({ type: ["string", "null"], anyOf: [{}], allOf: false }), "input", "nullable.input")).toThrow();
  });
});
