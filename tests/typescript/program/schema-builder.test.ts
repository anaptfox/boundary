import { describe, expect, it } from "vitest";
import { b } from "../../../packages/core/program/schema-builder";
import { validatePortableSchema } from "../../../packages/core/program/validation";
import { validateSchemaValue } from "../../../packages/core/program/schema-value";
import { contractCompatibility } from "../../../packages/core/program/compatibility";

describe("portable schema builder", () => {
  it("creates deeply portable strict object schemas and validates values", () => {
    const schema = b.object({ kind: b.literal("ready"), count: b.integer({ minimum: 1 }), note: b.optional(b.string()) });
    validatePortableSchema(schema);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(schema.required).toEqual(["kind", "count"]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 2 })).toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 2, other: true })).not.toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 0 })).not.toEqual([]);
  });

  it("supports unions, tuples, nullable values, and compatibility checks", () => {
    const a = b.object({ kind: b.literal("a") });
    const c = b.object({ kind: b.literal("c") });
    const schema = b.discriminatedUnion("kind", [a, c]);
    validatePortableSchema(schema);
    expect(validateSchemaValue(schema, { kind: "c" })).toEqual([]);
    expect(validateSchemaValue(schema, { kind: "x" })).not.toEqual([]);
    expect(validateSchemaValue(b.tuple([b.string(), b.boolean()]), ["ok", true])).toEqual([]);
    expect(validateSchemaValue(b.nullable(b.number()), null)).toEqual([]);
    const common = { version: 1 as const, id: "sample", reads: [], changes: [], inputSchema: b.string(), outputSchema: b.number() } as const;
    expect(contractCompatibility({ ...common, inputSchema: b.string({ minLength: 2 }) }, common).compatible).toBe(true);
  });
});
