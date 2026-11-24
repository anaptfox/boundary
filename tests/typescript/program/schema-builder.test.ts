import { describe, expect, expectTypeOf, it } from "vitest";
import { b, type InferSchema } from "../../../packages/core/program/schema-builder";
import { validatePortableSchema } from "../../../packages/core/program/validation";
import { validateSchemaValue } from "../../../packages/core/program/schema-value";
import { contractCompatibility } from "../../../packages/core/program/compatibility";
import { compileInteractions, defineInteraction } from "@foxworth/boundary";

describe("portable schema builder (b.*)", () => {
  it("creates strictly portable object schemas with required and optional properties", () => {
    const schema = b.object({
      kind: b.literal("ready"),
      count: b.integer({ minimum: 1 }),
      note: b.optional(b.string({ maxLength: 120 })),
    });

    type Value = InferSchema<typeof schema>;
    expectTypeOf<Value>().toEqualTypeOf<{
      readonly kind: "ready";
      readonly count: number;
      readonly note?: string;
    }>();

    validatePortableSchema(schema);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["kind", "count"]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 2 })).toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 2, note: "ok" })).toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 2, extra: true })).not.toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 0 })).not.toEqual([]);
    expect(validateSchemaValue(schema, { kind: "ready", count: 1.5 })).not.toEqual([]);
  });

  it("supports discriminated unions with exact type inference and duplicate tag rejection", () => {
    const created = b.object({ kind: b.literal("created"), id: b.string() });
    const deleted = b.object({ kind: b.literal("deleted"), id: b.string(), hard: b.boolean() });
    const event = b.discriminatedUnion("kind", [created, deleted]);

    type Event = InferSchema<typeof event>;
    expectTypeOf<Event>().toEqualTypeOf<
      | { readonly kind: "created"; readonly id: string }
      | { readonly kind: "deleted"; readonly id: string; readonly hard: boolean }
    >();

    validatePortableSchema(event);
    expect(validateSchemaValue(event, { kind: "created", id: "1" })).toEqual([]);
    expect(validateSchemaValue(event, { kind: "deleted", id: "1", hard: true })).toEqual([]);
    expect(validateSchemaValue(event, { kind: "other", id: "1" })).not.toEqual([]);

    expect(() =>
      b.discriminatedUnion("kind", [
        b.object({ kind: b.literal("dup") }),
        b.object({ kind: b.literal("dup") }),
      ]),
    ).toThrow(/duplicate discriminator/u);
  });

  it("supports enums, arrays, tuples, records, nullable, union, and json", () => {
    const status = b.enum(["open", "closed"]);
    expectTypeOf<InferSchema<typeof status>>().toEqualTypeOf<"open" | "closed">();

    const pair = b.tuple([b.string(), b.boolean()]);
    expectTypeOf<InferSchema<typeof pair>>().toEqualTypeOf<readonly [string, boolean]>();

    const tags = b.array(b.string(), { minItems: 1, uniqueItems: true });
    const meta = b.record(b.nullable(b.number()));
    const anyVal = b.json();
    const unionVal = b.union([b.string(), b.integer()]);

    for (const s of [status, pair, tags, meta, anyVal, unionVal]) {
      validatePortableSchema(s);
    }

    expect(validateSchemaValue(pair, ["ok", true])).toEqual([]);
    expect(validateSchemaValue(pair, ["ok", true, 1])).not.toEqual([]);
    expect(validateSchemaValue(meta, { a: 1, b: null })).toEqual([]);
    expect(validateSchemaValue(unionVal, 42)).toEqual([]);
    expect(validateSchemaValue(unionVal, "hi")).toEqual([]);
    expect(validateSchemaValue(unionVal, false)).not.toEqual([]);
  });

  it("integrates directly with defineInteraction, compileInteractions, and contractCompatibility", () => {
    const rename = defineInteraction({
      id: "docs.rename",
      input: b.object({ id: b.string({ minLength: 1 }), title: b.string({ minLength: 1 }) }),
      output: b.object({ id: b.string(), title: b.string() }),
      errors: {
        notFound: b.object({ id: b.string() }),
      },
      reads: ["documents"],
      changes: ["documents"],
    });

    const compiled = compileInteractions({ rename });
    expect(compiled.program.interactions).toHaveLength(1);

    const common = {
      version: 1 as const,
      id: "sample",
      reads: [],
      changes: [],
      inputSchema: b.string(),
      outputSchema: b.number(),
    } as const;
    expect(
      contractCompatibility({ ...common, inputSchema: b.string({ minLength: 2 }) }, common)
        .compatible,
    ).toBe(true);
  });
});
