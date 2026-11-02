import { describe, expect, it } from "vitest";
import { jsonEquals, type SnapshotFailure } from "../../packages/core/program/index";
import { exactObject, snapshotJson } from "../../packages/core/program/internal";

class SnapshotTestError extends Error {
  readonly failure: SnapshotFailure;

  constructor(failure: SnapshotFailure) {
    super(`${failure.code} at ${failure.path}: ${failure.message}`);
    this.failure = failure;
  }
}

function fail(failure: SnapshotFailure): never {
  throw new SnapshotTestError(failure);
}

function walk(
  value: unknown,
  options: {
    readonly path: string;
    readonly keys: readonly string[] | "discover";
    readonly optionalKeys?: readonly string[];
  },
): Record<string, unknown> {
  return exactObject(value, { ...options, fail });
}

function expectSnapshotFailure(run: () => unknown, code: string, path?: string): void {
  try {
    run();
    throw new Error("expected a SnapshotTestError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotTestError);
    const failure = (error as SnapshotTestError).failure;
    expect(failure.code).toBe(code);
    if (path !== undefined) expect(failure.path).toBe(path);
  }
}

describe("exactObject", () => {
  it("extracts exactly the required keys", () => {
    const result = walk(
      { id: "a", name: "b" },
      { path: "$", keys: ["id", "name"] },
    );
    expect(result).toEqual({ id: "a", name: "b" });
  });

  it("rejects a missing required key", () => {
    expectSnapshotFailure(
      () => walk({ id: "a" }, { path: "$", keys: ["id", "name"] }),
      "SNAPSHOT_MISSING_KEY",
      "$.name",
    );
  });

  it("rejects an extra key", () => {
    expectSnapshotFailure(
      () => walk({ id: "a", extra: true }, { path: "$", keys: ["id"] }),
      "SNAPSHOT_UNEXPECTED_KEY",
      "$.extra",
    );
  });

  it("accepts an absent optional key but rejects an unlisted one", () => {
    const result = walk(
      { id: "a" },
      { path: "$", keys: ["id"], optionalKeys: ["note"] },
    );
    expect(result).toEqual({ id: "a" });

    const withOptional = walk(
      { id: "a", note: "hi" },
      { path: "$", keys: ["id"], optionalKeys: ["note"] },
    );
    expect(withOptional).toEqual({ id: "a", note: "hi" });

    expectSnapshotFailure(
      () => walk({ id: "a", other: 1 }, { path: "$", keys: ["id"], optionalKeys: ["note"] }),
      "SNAPSHOT_UNEXPECTED_KEY",
      "$.other",
    );
  });

  it("rejects accessor properties without invoking them", () => {
    let calls = 0;
    const value = Object.defineProperty({}, "secret", {
      get() {
        calls += 1;
        return "secret";
      },
      enumerable: true,
    });
    expectSnapshotFailure(
      () => walk(value, { path: "$", keys: ["secret"] }),
      "SNAPSHOT_INVALID_PROPERTY",
      "$.secret",
    );
    expect(calls).toBe(0);
  });

  it("rejects non-enumerable data properties", () => {
    const value = Object.defineProperty({}, "hidden", {
      value: 1,
      enumerable: false,
    });
    expectSnapshotFailure(
      () => walk(value, { path: "$", keys: ["hidden"] }),
      "SNAPSHOT_INVALID_PROPERTY",
      "$.hidden",
    );
  });

  it("rejects symbol-keyed properties", () => {
    const value = { visible: true } as Record<PropertyKey, unknown>;
    value[Symbol("secret")] = true;
    expectSnapshotFailure(
      () => walk(value, { path: "$", keys: ["visible"] }),
      "SNAPSHOT_SYMBOL_KEY",
      "$",
    );
  });

  it("rejects a foreign prototype", () => {
    class Foreign {
      readonly id = "x";
    }
    expectSnapshotFailure(
      () => walk(new Foreign(), { path: "$", keys: ["id"] }),
      "SNAPSHOT_NOT_OBJECT",
      "$",
    );
  });

  it("accepts a null-prototype object", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.id = "a";
    expect(walk(value, { path: "$", keys: ["id"] })).toEqual({ id: "a" });
  });

  it("rejects arrays, null, and primitives", () => {
    expectSnapshotFailure(() => walk([], { path: "$", keys: [] }), "SNAPSHOT_NOT_OBJECT", "$");
    expectSnapshotFailure(() => walk(null, { path: "$", keys: [] }), "SNAPSHOT_NOT_OBJECT", "$");
    expectSnapshotFailure(() => walk("x", { path: "$", keys: [] }), "SNAPSHOT_NOT_OBJECT", "$");
  });

  it("does not fall prey to __proto__ prototype pollution", () => {
    const value = Object.defineProperty({}, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });

    const result = walk(value, { path: "$", keys: ["__proto__"] });

    // The value survives as an ordinary own data property...
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      polluted: true,
    });
    // ...and the result's own prototype is untouched.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("discover mode accepts every own string key and still rejects symbols and accessors", () => {
    const discovered = walk(
      { a: 1, b: 2, c: 3 },
      { path: "$", keys: "discover" },
    );
    expect(discovered).toEqual({ a: 1, b: 2, c: 3 });

    const symbolKeyed = { a: 1 } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("s")] = true;
    expectSnapshotFailure(
      () => walk(symbolKeyed, { path: "$", keys: "discover" }),
      "SNAPSHOT_SYMBOL_KEY",
      "$",
    );

    let calls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      get() {
        calls += 1;
        return 1;
      },
      enumerable: true,
    });
    expectSnapshotFailure(
      () => walk(accessor, { path: "$", keys: "discover" }),
      "SNAPSHOT_INVALID_PROPERTY",
      "$.secret",
    );
    expect(calls).toBe(0);

    const pollutionAttempt = Object.defineProperty({}, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const result = walk(pollutionAttempt, { path: "$", keys: "discover" });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result)).toEqual(["__proto__"]);
  });
});

describe("snapshotJson", () => {
  it("clones and freezes portable JSON", () => {
    const result = snapshotJson({ a: [1, "x", null] }, { path: "$", fail });
    expect(result).toEqual({ a: [1, "x", null] });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("routes JsonError diagnostics through the caller's fail callback", () => {
    expectSnapshotFailure(
      () => snapshotJson({ value: undefined }, { path: "$", fail }),
      "JSON_UNDEFINED",
      "$.value",
    );
  });
});

describe("jsonEquals", () => {
  it("compares by canonical form, independent of key order", () => {
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEquals([1, 2], [1, 2])).toBe(true);
  });
});
