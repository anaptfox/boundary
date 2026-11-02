import { describe, expect, it } from "vitest";
import { portableSchema, validateSchemaValue, type JsonSchema } from "../../packages/core/program/index";
import { validatePortableSchema } from "../../packages/core/program/validation";

describe("owned compiled portable schemas", () => {
  it("preserves code-point bounds and patterns independently", () => {
    const bounded = portableSchema({ type: "string", minLength: 2, maxLength: 2 });
    expect(validateSchemaValue(bounded, "a😀")).toEqual([]);
    expect(validateSchemaValue(bounded, "😀")).toEqual([
      { path: "value", message: "string must contain at least 2 code points" },
    ]);
    expect(validateSchemaValue(bounded, "a😀b")).toEqual([
      { path: "value", message: "string must contain at most 2 code points" },
    ]);
    expect(validateSchemaValue(portableSchema({ minLength: 1 }), "")).toEqual([
      { path: "value", message: "string must contain at least 1 code points" },
    ]);
    expect(validateSchemaValue(portableSchema({ maxLength: 0 }), "😀")).toEqual([
      { path: "value", message: "string must contain at most 0 code points" },
    ]);
    const pattern = portableSchema({ type: "string", pattern: "^a+$" });
    expect(validateSchemaValue(pattern, "aaaa")).toEqual([]);
    expect(validateSchemaValue(pattern, "b")).toEqual([
      { path: "value", message: "string must match pattern" },
    ]);
  });

  it("revalidates caller objects after prior validation, including nested mutation", () => {
    const child = { type: "string", pattern: "^a$" };
    const schema = { type: "object", properties: { item: child } };
    validatePortableSchema(schema);
    expect(validateSchemaValue(schema, { item: "a" })).toEqual([]);
    child.pattern = "^b$";
    expect(validateSchemaValue(schema, { item: "a" })).toEqual([
      { path: "value.item", message: "string must match pattern" },
    ]);
    child.type = "nonsense";
    expect(() => validatePortableSchema(schema)).toThrow();
    expect(() => validateSchemaValue(schema, { item: "b" })).toThrow();
  });

  it("does not trust a shallow freeze or invoke an accessor added after validation", () => {
    const child = { type: "string" };
    const schema = Object.freeze({ properties: { child } });
    validatePortableSchema(schema);
    let calls = 0;
    Object.defineProperty(child, "type", { get() { calls++; return "string"; } });
    expect(() => validateSchemaValue(schema, { child: "ok" })).toThrow();
    expect(calls).toBe(0);
  });

  it("owns patterns and property tables without changing ordered diagnostic paths", () => {
    const branches: JsonSchema[] = [
      { anyOf: [{ type: "string", pattern: "^a" }, { type: "number" }] },
      { not: { const: 2 } },
    ];
    const source = {
      type: "object", required: ["missing"], additionalProperties: false,
      properties: {
        list: { type: "array", items: { allOf: branches } },
      },
    };
    const schema = portableSchema(source);
    source.properties.list.items.allOf.length = 0;
    const expected = [
      { path: "input.missing", message: "required property is missing" },
      { path: "input.list[0]", message: "value must match at least one anyOf schema" },
      { path: "input.list[1]", message: "value must not match the excluded schema" },
      { path: "input.extra", message: "additional property is not allowed" },
    ];
    for (let run = 0; run < 3; run++) {
      expect(validateSchemaValue(schema, { list: ["bad", 2], extra: true }, "input")).toEqual(expected);
    }
  });

  it("oneOf counts overlapping branches and additional property schemas remain executable", () => {
    const schema = portableSchema({ type: "object", additionalProperties: {
      oneOf: [{ type: "number" }, { type: "integer" }, { type: "string" }],
    } });
    expect(validateSchemaValue(schema, { x: 1.5, y: "ok" })).toEqual([]);
    expect(validateSchemaValue(schema, { x: 1 })).toEqual([
      { path: "value.x", message: "value must match exactly one oneOf schema" },
    ]);
  });
});
