import { describe, expect, it } from "vitest";
import { canonicalJson, cloneJson, createInteractionDescriptor, JsonError, normalizeJson, type JsonArray, type JsonObject, type JsonValue, type InteractionDescriptorSource } from "../../packages/core/program/index";
import { compareUtf8 } from "../../packages/core/program/internal";

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function expectJsonFailure(
  value: unknown,
  code: JsonError["code"],
  path: string,
): void {
  expect(() => canonicalJson(asJson(value))).toThrowError(
    expect.objectContaining({ name: "JsonError", code, path }),
  );
}

describe("strict Boundary program JSON", () => {
  it("normalizes plain JSON deterministically and deeply freezes the clone", () => {
    const shared = { z: -0, a: [true, null, "é"] };
    const normalized = normalizeJson({ second: shared, first: shared });

    expect(canonicalJson(normalized)).toBe(
      '{"first":{"a":[true,null,"é"],"z":0},"second":{"a":[true,null,"é"],"z":0}}',
    );
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen((normalized as JsonObject).first)).toBe(true);
    expect(
      Object.isFrozen(((normalized as JsonObject).first as JsonObject).a),
    ).toBe(true);
    expect(
      Object.is(((normalized as JsonObject).first as JsonObject).z, -0),
    ).toBe(false);
  });

  it("accepts plain null-prototype records without prototype pollution", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "__proto__", {
      value: { safe: true },
      enumerable: true,
    });

    const normalized = normalizeJson(value) as JsonObject;

    expect(canonicalJson(normalized)).toBe('{"__proto__":{"safe":true}}');
    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(
      true,
    );
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  });

  it("preserves fresh root and nested copies when normalizing owned snapshots", () => {
    const owned = normalizeJson({ items: [{ label: "before" }] }) as JsonObject;
    const originalItems = owned.items as JsonArray;
    for (const result of [normalizeJson(owned), cloneJson(owned)]) {
      const copy = result as JsonObject;
      const items = copy.items as JsonArray;
      expect(copy).toEqual(owned);
      expect(copy).not.toBe(owned);
      expect(items).not.toBe(originalItems);
      expect(items[0]).not.toBe(originalItems[0]);
      expect(Object.isFrozen(copy)).toBe(true);
      expect(Object.isFrozen(items)).toBe(true);
      expect(Object.isFrozen(items[0])).toBe(true);
      expect(Reflect.set(items[0] as object, "label", "changed")).toBe(false);
      expect(canonicalJson(copy)).toBe('{"items":[{"label":"before"}]}');
    }
    const repeated = normalizeJson({ first: owned, second: owned }) as JsonObject;
    expect(repeated.first).not.toBe(owned);
    expect(repeated.second).not.toBe(owned);
    expect(repeated.first).not.toBe(repeated.second);
    expect((repeated.first as JsonObject).items).not.toBe(originalItems);
  });

  it("rechecks mutable and shallow-frozen caller objects after normalization", () => {
    const child = { value: "first" };
    const source = Object.freeze({ child });
    const first = normalizeJson(source);
    child.value = "second";
    expect(canonicalJson(first)).toBe('{"child":{"value":"first"}}');
    expect(canonicalJson(source)).toBe('{"child":{"value":"second"}}');
    let calls = 0;
    Object.defineProperty(child, "value", {
      get() { calls++; return "third"; },
      enumerable: true,
    });
    expectJsonFailure(source, "JSON_ACCESSOR_PROPERTY", "$.child.value");
    expect(calls).toBe(0);
  });

  it("does not trust a frozen accessor or a proxy around an owned object", () => {
    let calls = 0;
    const accessor = Object.freeze(Object.defineProperty({}, "value", {
      get() { calls++; return "secret"; },
      enumerable: true,
    }));
    expectJsonFailure(accessor, "JSON_ACCESSOR_PROPERTY", "$.value");
    expect(calls).toBe(0);
    const owned = normalizeJson({ value: "safe" }) as JsonObject;
    const proxy = new Proxy(owned, {
      ownKeys() { throw new Error("inspection blocked"); },
    });
    expectJsonFailure(proxy, "JSON_INSPECTION_FAILED", "$");
    expect(() => cloneJson(proxy)).toThrowError(
      expect.objectContaining({ code: "JSON_INSPECTION_FAILED", path: "$" }),
    );
  });

  it("keeps __proto__ as an own data property when copying owned snapshots", () => {
    const raw = Object.create(null) as Record<string, JsonValue>;
    raw.__proto__ = { nested: ["safe"] };
    const owned = normalizeJson(raw) as JsonObject;
    const copied = cloneJson(owned);
    expect(copied).not.toBe(owned);
    expect(copied.__proto__).not.toBe(owned.__proto__);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(canonicalJson(copied)).toBe('{"__proto__":{"nested":["safe"]}}');
    expect(Object.hasOwn(Object.prototype, "nested")).toBe(false);
  });

  it("retains UTF-8 key ordering for raw and owned data including integer keys", () => {
    const raw = { "\u{10000}": 6, "\ue000": 4, "\ufffd": 5, "é": 3, a: 2,
      "2": 1, "10": 0, "\u{10ffff}": 7 };
    const expected = '{"10":0,"2":1,"a":2,"é":3,"\ue000":4,"\ufffd":5,"\u{10000}":6,"\u{10ffff}":7}';
    const owned = normalizeJson(raw);
    expect(canonicalJson(raw)).toBe(expected);
    expect(canonicalJson(owned)).toBe(expected);
    expect(canonicalJson(cloneJson(owned))).toBe(expected);
  });

  it("preserves exact UTF-8 comparator results with the ASCII fast path", () => {
    const encoder = new TextEncoder();
    const reference = (left: string, right: string) => {
      const a = encoder.encode(left), b = encoder.encode(right);
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const difference = a[index]! - b[index]!;
        if (difference !== 0) return difference;
      }
      return a.length - b.length;
    };
    const values = ["", "a", "ab", "abc", "abd", "key1", "key10", "key2",
      "\0", "\u007f", "\u0080", "aé", "a😀", "é", "\ue000", "\ufffd",
      "\u{10000}", "\u{10ffff}", "\ud800", "\udfff", "\ud800a", "\udfffz"];
    for (const left of values) for (const right of values) {
      expect(compareUtf8(left, right)).toBe(reference(left, right));
    }
  });

  it("rejects every lone surrogate while accepting paired scalar boundaries", () => {
    for (let unit = 0xd800; unit <= 0xdfff; unit++) {
      expectJsonFailure({ value: String.fromCharCode(unit) }, "JSON_INVALID_UNICODE", "$.value");
    }
    for (const value of ["\ud800\ud800", "\udc00\ud800", "a\ud800b", "\udfff\udfff"]) {
      expectJsonFailure([value], "JSON_INVALID_UNICODE", "$[0]");
    }
    for (const value of ["", "\ud7ff", "\ue000", "\ud800\udc00", "\udbff\udfff", "a😀b"]) {
      expect(normalizeJson(value)).toBe(value);
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
    const invalidKey = "\ud800";
    expectJsonFailure({ [invalidKey]: "value" }, "JSON_INVALID_UNICODE", '$["\\ud800"]');
  });

  it("rejects non-plain objects instead of collapsing them to empty records", () => {
    class RecordValue {
      readonly id = "record-1";
    }

    for (const value of [
      new Date("2026-01-01T00:00:00.000Z"),
      new Map([["key", "value"]]),
      new Set(["value"]),
      new RecordValue(),
    ]) {
      expectJsonFailure(value, "JSON_NON_PLAIN_OBJECT", "$");
    }
  });

  it("rejects accessors and symbol or hidden properties without invoking them", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      get() {
        getterCalls += 1;
        return "secret";
      },
      enumerable: true,
    });
    const symbolKey = { visible: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("secret")] = true;
    const hidden = Object.defineProperty({}, "secret", {
      value: "secret",
      enumerable: false,
    });

    expectJsonFailure(accessor, "JSON_ACCESSOR_PROPERTY", "$.secret");
    expect(getterCalls).toBe(0);
    expectJsonFailure(symbolKey, "JSON_SYMBOL_KEY", "$");
    expectJsonFailure(hidden, "JSON_NON_ENUMERABLE_PROPERTY", "$.secret");
  });

  it("rejects undefined, BigInt, non-finite numbers, holes, and extra array state", () => {
    expectJsonFailure({ value: undefined }, "JSON_UNDEFINED", "$.value");
    expectJsonFailure([undefined], "JSON_UNDEFINED", "$[0]");
    expectJsonFailure({ value: 1n }, "JSON_UNSUPPORTED_TYPE", "$.value");
    expectJsonFailure({ value: Number.NaN }, "JSON_NON_FINITE_NUMBER", "$.value");
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the input under test
    expectJsonFailure([, "value"], "JSON_ARRAY_HOLE", "$[0]");

    const array = ["value"] as string[] & { metadata?: string };
    array.metadata = "hidden state";
    expectJsonFailure(
      array,
      "JSON_UNSUPPORTED_PROPERTY",
      "$.metadata",
    );
  });

  it("rejects cycles and unpaired surrogates while allowing repeated values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectJsonFailure(cyclic, "JSON_CYCLIC_REFERENCE", "$.self");
    expectJsonFailure({ value: "\ud800" }, "JSON_INVALID_UNICODE", "$.value");

    const repeated = { value: 1 };
    expect(canonicalJson({ left: repeated, right: repeated })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );
  });

  it("exposes stable JSON diagnostics when advanced descriptors contain runtime impostors", async () => {
    const source: InteractionDescriptorSource = {
      contract: {
        version: 1,
        id: "records.read",
        inputSchema: new Date() as unknown as JsonObject,
        outputSchema: { type: "object" },
        reads: ["records"],
        changes: [],
      },
      docs: { summary: "Read a record" },
    };

    await expect(createInteractionDescriptor(source)).rejects.toMatchObject({
      name: "JsonError",
      code: "JSON_NON_PLAIN_OBJECT",
      path: "records.read.inputSchema",
    });
  });

  it("deeply freezes normalized descriptor data", async () => {
    const descriptor = await createInteractionDescriptor({
      contract: {
        version: 1,
        id: "records.read",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        outputSchema: { type: "object" },
        reads: ["records"],
        changes: [],
      },
      docs: { summary: "Read records" },
      annotations: { "records.projection/v1": { layout: "list" } },
    });
    const inputProperties = descriptor.contract.inputSchema.properties;
    const projection = descriptor.annotations["records.projection/v1"];

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.contract)).toBe(true);
    expect(Object.isFrozen(descriptor.contract.inputSchema)).toBe(true);
    expect(Object.isFrozen(inputProperties)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
  });
});
