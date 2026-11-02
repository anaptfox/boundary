import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileZodSchema,
  SchemaCompilationError,
} from "@foxworth/boundary/program/zod";
import { compileZodSchema as compileInternalZodSchema } from "../../packages/core/program/zod";
import { isPortableSchema, portableSchema, validateSchemaValue, type PortableSchemaValue, type SchemaAdapter } from "../../packages/core/program/index";
import { compileSchema } from "../../packages/core/program/internal";

describe("portable schema compiler", () => {
  it("publishes the exact hardened Zod compiler through the direct package", () => {
    expect(compileZodSchema).toBe(compileInternalZodSchema);
  });

  it("authors validated, normalized, deeply frozen literal schemas with value typing", () => {
    const schema = portableSchema<{ readonly title: string }>({
      required: ["title"],
      properties: { title: { minLength: 1, type: "string" } },
      type: "object",
      additionalProperties: false,
    });
    const value: PortableSchemaValue<typeof schema> = { title: "Ship it" };

    expect(value.title).toBe("Ship it");
    expect(schema).toEqual({
      additionalProperties: false,
      properties: { title: { minLength: 1, type: "string" } },
      required: ["title"],
      type: "object",
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
    expect(
      Object.isFrozen(
        (schema.properties as Readonly<Record<string, object>>)["title"],
      ),
    ).toBe(true);
    expect(isPortableSchema(schema)).toBe(true);
    expect(isPortableSchema(JSON.parse(JSON.stringify(schema)))).toBe(false);
    expect(Object.getOwnPropertySymbols(schema)).toEqual([]);
    expect(() => portableSchema({ type: "string", format: "email" } as never))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_UNSUPPORTED_KEYWORD" }));
  });

  it("enforces uniqueItems with canonical JSON equality", () => {
    const schema = portableSchema<readonly { readonly a: number; readonly b: number }[]>({
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
    });

    expect(validateSchemaValue(schema, [{ a: 1, b: 2 }], "input")).toEqual([]);
    expect(
      validateSchemaValue(
        schema,
        [{ a: 1, b: 2 }, { b: 2, a: 1 }],
        "input",
      ),
    ).toEqual([
      expect.objectContaining({
        path: "input[1]",
        message: "array items must be unique",
      }),
    ]);
    expect(() => portableSchema({ type: "array", uniqueItems: 1 } as never))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_CONTRACT_INVALID" }));
  });

  it("separates validation assertions from projector annotations", () => {
    const compiled = compileZodSchema(
      z.strictObject({
        title: z
          .string()
          .min(1)
          .meta({
            title: "Todo title",
            description: "Human-facing copy",
            role: "display",
            control: "line",
          }),
      }),
      "input",
      "todos.create.input",
    );

    expect(compiled.contract).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1 },
      },
      required: ["title"],
    });
    expect(compiled.annotations).toEqual({
      properties: {
        title: {
          title: "Todo title",
          description: "Human-facing copy",
          role: "display",
          control: "line",
        },
      },
    });
  });

  it.each([
    ["trim", z.string().trim()],
    ["default", z.string().default("todo")],
    ["coerce", z.coerce.number()],
    ["custom refinement", z.string().refine((value) => value.length > 0)],
  ])("rejects non-portable %s semantics", (_name, schema) => {
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(SchemaCompilationError);
    try {
      compileZodSchema(schema, "input", "interaction.input");
    } catch (error) {
      expect(error).toMatchObject({ code: "SCHEMA_RUNTIME_TRANSFORM" });
    }
  });

  it.each([
    [
      "object catchall",
      z.strictObject({ value: z.string() }).catchall(
        z.string().refine((value) => value.length > 0),
      ),
    ],
  ])("rejects a hidden refinement in a %s", (_name, schema) => {
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_RUNTIME_TRANSFORM" }),
    );
  });

  it("rejects template literals whose outer regex loses Unicode semantics", () => {
    const schema = z.templateLiteral([z.string().regex(/^.$/u)]);
    expect(schema.safeParse("😀").success).toBe(false);
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );
  });

  it("rejects property checks omitted from Zod's generated contract", () => {
    const schema = z
      .object({ x: z.string() })
      .check(z.property("x", z.string().min(2)));
    expect(schema.safeParse({ x: "a" }).success).toBe(false);
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );
  });

  it("rejects properties checks omitted from Zod's generated contract", () => {
    const schema = z.strictObject({ x: z.string() })
      .check(z.properties({ x: z.string().min(2) }));
    expect(schema.validate({ x: "a" })).toBe(false);
    expect(() => compileZodSchema(schema, "input", "interaction.input"))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }));
  });

  it("rejects attached parser fast paths whose declaration cannot prove their behavior", () => {
    const declaration = z.string();
    const attached = z.withParser(declaration, () => "substituted");
    expect(attached.parse(42)).toBe("substituted");
    expect(declaration.validate(42)).toBe(false);
    for (const schema of [attached, z.compile(declaration)]) {
      expect(() => compileZodSchema(schema, "input", "interaction.input"))
        .toThrowError(expect.objectContaining({
          code: "SCHEMA_RUNTIME_TRANSFORM",
          path: "interaction.input",
        }));
      expect(() => compileZodSchema(z.strictObject({ title: schema }), "input", "interaction.input"))
        .toThrowError(expect.objectContaining({
          code: "SCHEMA_RUNTIME_TRANSFORM",
          path: "interaction.input.title",
        }));
    }
    expect(compileZodSchema(declaration, "input", "interaction.input").contract)
      .toEqual({ type: "string" });
  });

  it("preserves chained numeric constraints regardless of Zod check order", () => {
    const schemas = [
      z.number().min(0).max(23).int(),
      z.number().int().min(0).max(23),
    ];
    for (const schema of schemas) {
      const compiled = compileZodSchema(schema, "input", "interaction.input");
      expect(compiled.contract).toEqual({ type: "integer", minimum: 0, maximum: 23 });
      for (const input of [-1, 0, 1.5, 23, 24]) {
        expect(validateSchemaValue(compiled.contract, input).length === 0)
          .toBe(schema.validate(input));
      }
    }
  });

  it("requires strict objects so Zod and the closed contract agree on unknown keys", () => {
    for (const schema of [z.object({ a: z.string() }), z.strictObject({ nested: z.object({ b: z.string() }) })]) {
      expect(() => compileZodSchema(schema, "input", "interaction.input")).toThrowError(
        expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE", message: expect.stringContaining("z.strictObject()") }),
      );
    }
    const strict = compileZodSchema(z.strictObject({ a: z.string() }), "input", "interaction.input");
    expect(compileZodSchema(z.object({ a: z.string() }).strict(), "input", "interaction.input").contract).toEqual(strict.contract);
    const catchall = z.object({ a: z.string() }).catchall(z.number());
    const compiled = compileZodSchema(catchall, "input", "interaction.input");
    for (const input of [{ a: "x" }, { a: "x", n: 1 }, { a: "x", n: "y" }]) {
      expect(validateSchemaValue(compiled.contract, input as never).length === 0).toBe(catchall.safeParse(input).success);
    }
  });

  it("compiles exclusive unions of strict objects to oneOf that agrees with Zod", () => {
    const cases: Array<[z.ZodType, unknown[]]> = [
      [z.xor([z.strictObject({ a: z.string(), b: z.string() }), z.strictObject({ a: z.string() })]), [{ a: "x", b: "y" }, { a: "x" }, { a: "x", b: "y", c: 1 }]],
      [z.xor([z.strictObject({ a: z.string() }), z.strictObject({ a: z.string(), b: z.string().optional() })]), [{ a: "x" }, { a: "x", b: "y" }]],
      [z.discriminatedUnion("k", [z.strictObject({ k: z.literal("a") }), z.strictObject({ k: z.literal("b"), id: z.string() })]), [{ k: "a" }, { k: "b", id: "1" }, { k: "a", id: "1" }, { k: "c" }]],
      [z.xor([z.number().int(), z.number().min(0)]), [1, -1, 0.5, -0.5]],
    ];
    for (const [schema, inputs] of cases) {
      const compiled = compileZodSchema(schema, "input", "interaction.input");
      expect(compiled.contract).toHaveProperty("oneOf");
      for (const input of inputs) {
        expect(validateSchemaValue(compiled.contract, input as never).length === 0).toBe(schema.safeParse(input).success);
      }
    }
  });

  it.each([
    ["any", z.any()],
    ["unknown", z.unknown()],
    ["custom", z.custom<unknown>()],
    ["file", z.file()],
  ])("rejects Zod %s because it accepts non-JSON runtime values", (_name, schema) => {
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NON_JSON_TYPE" }),
    );
  });

  it("keeps Zod's uuid and email patterns and rejects formats without one", () => {
    const cases: Array<[z.ZodType, unknown[]]> = [
      [z.uuid(), ["123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000", "00000000-0000-0000-0000-000000000000", "123e4567-e89b-02d3-a456-426614174000", "nope"]],
      [z.email(), ["a@b.co", "a.b+c@d.example", "a@b.c", "x"]],
    ];
    for (const [schema, inputs] of cases) {
      const compiled = compileZodSchema(schema, "input", "interaction.input");
      expect(compiled.contract).toEqual({ type: "string", pattern: expect.any(String) });
      for (const input of inputs) {
        expect(validateSchemaValue(compiled.contract, input as never).length === 0).toBe(schema.safeParse(input).success);
      }
    }
    expect(() => compileZodSchema(z.url(), "input", "interaction.input")).toThrow(/SCHEMA_UNSUPPORTED_KEYWORD/);
  });

  it("requires Unicode regular-expression semantics to match JSON Schema", () => {
    expect(() =>
      compileZodSchema(
        z.string().regex(/abc/i),
        "input",
        "interaction.input",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );

    expect(z.string().regex(/^.$/).safeParse("😀").success).toBe(false);
    expect(() =>
      compileZodSchema(z.string().regex(/^.$/), "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );

    expect(z.string().regex(/^.$/u).safeParse("😀").success).toBe(true);
    expect(() =>
      compileZodSchema(z.string().regex(/^.$/u), "input", "interaction.input"),
    ).not.toThrow();
  });

  it("rejects recursive schemas instead of recursing indefinitely", () => {
    let category!: z.ZodType;
    category = z.strictObject({
      name: z.string(),
      get children(): z.ZodType {
        return z.array(category);
      },
    });

    expect(() =>
      compileZodSchema(category, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );
  });

  it("treats Zod string lengths as Unicode code points matching JSON Schema", () => {
    expect(z.string().min(2).safeParse("😀").success).toBe(false);
    expect(z.string().min(1).safeParse("😀").success).toBe(true);
    expect(compileZodSchema(z.string().min(2), "input", "interaction.input").contract)
      .toEqual({ type: "string", minLength: 2 });
    expect(compileZodSchema(z.string().max(1), "input", "interaction.input").contract)
      .toEqual({ type: "string", maxLength: 1 });
    expect(
      compileZodSchema(z.string().length(1), "input", "interaction.input").contract,
    ).toEqual({ type: "string", minLength: 1, maxLength: 1 });
  });

  it("rejects positioned includes checks whose emitted pattern is stricter", () => {
    const schema = z.string().includes("x", { position: 2 });
    expect(schema.safeParse("aabx").success).toBe(true);
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );
  });

  it("rejects floating-tolerance multipleOf semantics", () => {
    const schema = z.number().multipleOf(0.1);
    expect(schema.safeParse(0.30000000000000004).success).toBe(true);
    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
    );
  });

  it("compiles an intersection of disjoint strict objects to one closed object", () => {
    const schema = z.intersection(
      z.strictObject({ id: z.string().min(1) }),
      z.strictObject({ revision: z.number().int().positive() }),
    );
    const compiled = compileZodSchema(schema, "input", "interaction.input");
    expect(compiled.contract).toMatchObject({ type: "object", required: ["id", "revision"], additionalProperties: false });
    expect(compiled.contract).not.toHaveProperty("allOf");
    for (const input of [{ id: "a", revision: 2 }, { id: "a" }, { id: "a", revision: 2, x: 1 }, { id: "", revision: 2 }]) {
      expect(validateSchemaValue(compiled.contract, input as never).length === 0).toBe(schema.safeParse(input).success);
    }
  });

  it("rejects intersections Zod merges differently from the contract", () => {
    for (const schema of [
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })),
      z.intersection(z.strictObject({ a: z.string() }), z.strictObject({ a: z.string().min(1) })),
      z.intersection(z.string(), z.string().min(1)),
    ]) {
      expect(() => compileZodSchema(schema, "input", "interaction.input")).toThrowError(
        expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
      );
    }
  });

  it("compiles tuples and rest tuples to prefixItems that agree with Zod", () => {
    const byte = z.number().int().min(0).max(255);
    const cases: Array<[z.ZodType, unknown[]]> = [
      [z.tuple([byte, z.string()]), [[1, "a"], [256, "a"], [1, 2], [1], [], [1, "a", "b"], ["a", 1], {}]],
      [z.tuple([z.string()]).rest(z.number()), [["a"], ["a", 1, 2], ["a", "b"], [], [1]]],
      [z.tuple([z.string(), z.number().optional()]), [["a"], ["a", 1], ["a", "b"], ["a", 1, 2]]],
      [z.tuple([z.strictObject({ id: z.string() }), z.string().nullable()]), [[{ id: "a" }, null], [{ id: "a", x: 1 }, "b"], [{ id: "a" }]]],
    ];
    for (const [schema, inputs] of cases) {
      const compiled = compileZodSchema(schema, "input", "interaction.input");
      expect(compiled.contract).toHaveProperty("prefixItems");
      for (const input of inputs) {
        expect(validateSchemaValue(compiled.contract, input as never).length === 0, JSON.stringify(input)).toBe(schema.safeParse(input).success);
      }
    }
    expect(compileZodSchema(z.tuple([byte, z.string()]), "input", "interaction.input").contract).toEqual({
      type: "array",
      prefixItems: [{ type: "integer", minimum: 0, maximum: 255 }, { type: "string" }],
      items: false,
      minItems: 2,
      maxItems: 2,
    });
  });

  it("compiles string-keyed records to propertyNames that agree with Zod", () => {
    const cases: Array<[z.ZodType, unknown[]]> = [
      [z.record(z.string().min(1), z.string().max(40)), [{}, { a: "x" }, { "": "x" }, { a: "x".repeat(41) }, { a: 1 }, []]],
      [z.record(z.string(), z.number().int().min(0).max(255)), [{}, { a: 1, b: 255 }, { a: 256 }, { "": 0 }, { a: "1" }]],
      [z.record(z.string().regex(/^[a-z]+$/u), z.boolean()), [{ ok: true }, { Bad: true }, { ok: "no" }]],
    ];
    for (const [schema, inputs] of cases) {
      const compiled = compileZodSchema(schema, "input", "interaction.input");
      for (const input of inputs) {
        expect(validateSchemaValue(compiled.contract, input as never).length === 0, JSON.stringify(input)).toBe(schema.safeParse(input).success);
      }
    }
    // A plain string key asserts nothing, so its propertyNames is dropped.
    expect(compileZodSchema(z.record(z.string(), z.number()), "input", "interaction.input").contract).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
    expect(compileZodSchema(z.record(z.string().min(1), z.number()), "input", "interaction.input").contract).toEqual({
      type: "object",
      propertyNames: { type: "string", minLength: 1 },
      additionalProperties: { type: "number" },
    });
  });

  it("rejects records whose keys Zod treats as exhaustive or passes through", () => {
    for (const schema of [
      z.record(z.enum(["a", "b"]), z.number()),
      z.partialRecord(z.enum(["a", "b"]), z.number()),
      z.record(z.literal("a"), z.number()),
      z.record(z.number(), z.number()),
      z.looseRecord(z.string().min(1), z.number()),
      z.tuple([]),
    ]) {
      expect(() => compileZodSchema(schema as z.ZodType, "input", "interaction.input")).toThrowError(
        expect.objectContaining({ code: "SCHEMA_NOT_PORTABLE" }),
      );
    }
  });

  it("keeps only the boolean false for items and requires non-empty prefixItems", () => {
    expect(() => portableSchema({ type: "array", items: true })).toThrowError(
      expect.objectContaining({ code: "SCHEMA_CONTRACT_INVALID" }),
    );
    expect(() => portableSchema({ type: "array", prefixItems: [] })).toThrowError(
      expect.objectContaining({ code: "SCHEMA_CONTRACT_INVALID" }),
    );
    expect(() => portableSchema({ type: "object", propertyNames: true })).toThrowError(
      expect.objectContaining({ code: "SCHEMA_CONTRACT_INVALID" }),
    );
    expect(() => portableSchema({ type: "number", multipleOf: 2 })).toThrowError(
      expect.objectContaining({ code: "SCHEMA_UNSUPPORTED_KEYWORD" }),
    );
    const empty = portableSchema({ type: "array", items: false });
    expect(validateSchemaValue(empty, []).length).toBe(0);
    expect(validateSchemaValue(empty, [1]).length).toBe(1);
  });

  it("rejects non-JSON schema metadata before it can collapse to an empty object", () => {
    const schema = z.string().meta({
      examples: [new Date("2026-01-01T00:00:00.000Z")],
    });

    expect(() =>
      compileZodSchema(schema, "input", "interaction.input"),
    ).toThrowError(
      expect.objectContaining({
        name: "SchemaCompilationError",
        code: "SCHEMA_NON_JSON_VALUE",
        path: "interaction.input.metadata.examples[0]",
      }),
    );
  });

  it("supports alternate schema adapters through one strict JSON seam", () => {
    type Shape = { readonly fields: readonly string[] };
    const adapter: SchemaAdapter<Shape> = {
      compile(schema, context) {
        return {
          contract: {
            type: "object",
            properties: Object.fromEntries(
              schema.fields.map((field) => [field, { type: "string" }]),
            ),
          },
          annotations: { role: context.role },
        };
      },
    };

    expect(
      compileSchema(
        { fields: ["title"] },
        adapter,
        { role: "error", path: "todos.create.error" },
      ),
    ).toEqual({
      contract: {
        type: "object",
        properties: { title: { type: "string" } },
      },
      annotations: { role: "error" },
    });
  });

  it("rejects alternate adapters that broaden the portable schema profile", () => {
    const adapter: SchemaAdapter<null> = {
      compile() {
        return { contract: { type: "string", format: "email" } };
      },
    };

    expect(() =>
      compileSchema(null, adapter, {
        role: "input",
        path: "messages.send.input",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_UNSUPPORTED_KEYWORD" }),
    );
  });

  it("executes the canonical contract with Unicode-aware semantics", () => {
    const schema = {
      type: "object",
      properties: {
        glyph: { type: "string", minLength: 1, maxLength: 1, pattern: "^.$" },
      },
      required: ["glyph"],
      additionalProperties: false,
    } as const;

    expect(validateSchemaValue(schema, { glyph: "😀" }, "input")).toEqual([]);
    expect(validateSchemaValue(schema, { glyph: "ab" }, "input")).toEqual([
      expect.objectContaining({ path: "input.glyph" }),
      expect.objectContaining({ path: "input.glyph" }),
    ]);
    expect(validateSchemaValue(schema, { glyph: "x", extra: true }, "input"))
      .toEqual([
        expect.objectContaining({ path: "input.extra" }),
      ]);
  });

  it("requires object properties to be own properties", () => {
    const schema = {
      type: "object",
      required: ["toString"],
    } as const;

    expect(validateSchemaValue(schema, {}, "input")).toEqual([
      expect.objectContaining({ path: "input.toString" }),
    ]);
  });
});
