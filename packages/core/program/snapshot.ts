import { JsonError, canonicalJson, normalizeJson, type JsonValue } from "./json";

/** A structured, class-agnostic failure. `fail` turns it into a thrown error. */
export type SnapshotFailure = { code: string; path: string; message: string };

type ExactObjectOptions = {
  readonly path: string;
  /**
   * The exact expected key set, or `"discover"` to accept every own string
   * key the object actually has (still rejecting symbols, accessors, and
   * prototype pollution). Discover mode lets callers that must learn an
   * object's keys before validating them route the walk itself through this
   * kernel instead of pre-walking with `Reflect.ownKeys` and feeding the
   * discovered set back in, which degrades this check to accessor-only.
   */
  readonly keys: readonly string[] | "discover";
  readonly optionalKeys?: readonly string[];
  readonly fail: (failure: SnapshotFailure) => never;
};

function propertyPath(path: string, key: string): string {
  return `${path}.${key}`;
}

/**
 * Walk an own-enumerable-data-only object. Rejects accessors, symbols, extra
 * keys, and prototype pollution. `keys` are required (or `"discover"`);
 * `optionalKeys` may be absent but, if present, must be exact data properties
 * like every other key.
 */
export function exactObject(
  value: unknown,
  options: ExactObjectOptions,
): Record<string, unknown> {
  const { path, keys, fail } = options;
  const discover = keys === "discover";
  const optionalKeys = options.optionalKeys ?? [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail({
      code: "SNAPSHOT_NOT_OBJECT",
      path,
      message: "value must be a plain object",
    });
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return fail({
      code: "SNAPSHOT_INSPECTION_FAILED",
      path,
      message: "object could not be inspected",
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail({
      code: "SNAPSHOT_NOT_OBJECT",
      path,
      message: "value must be a plain object",
    });
  }
  const allowed = discover ? undefined : new Set([...keys, ...optionalKeys]);
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return fail({
        code: "SNAPSHOT_SYMBOL_KEY",
        path,
        message: "object must not have symbol-keyed properties",
      });
    }
    // Reflect.ownKeys never yields a `number`; PropertyKey only claims it can.
    const stringKey = key as string;
    if (allowed !== undefined && !allowed.has(stringKey)) {
      return fail({
        code: "SNAPSHOT_UNEXPECTED_KEY",
        path: propertyPath(path, stringKey),
        message: `unexpected property: ${stringKey}`,
      });
    }
  }
  if (!discover) {
    for (const key of keys) {
      if (!ownKeys.includes(key)) {
        return fail({
          code: "SNAPSHOT_MISSING_KEY",
          path: propertyPath(path, key),
          message: `required property is missing: ${key}`,
        });
      }
    }
  }
  const result: Record<string, unknown> = {};
  for (const key of ownKeys as readonly string[]) {
    const keyPath = propertyPath(path, key);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return fail({
        code: "SNAPSHOT_INSPECTION_FAILED",
        path: keyPath,
        message: "property could not be inspected",
      });
    }
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return fail({
        code: "SNAPSHOT_INVALID_PROPERTY",
        path: keyPath,
        message: "property must be an enumerable data property",
      });
    }
    // Object.defineProperty, not `result[key] = ...`: a plain assignment for
    // key "__proto__" hits Object.prototype's setter instead of creating an
    // own property, silently dropping the value and replacing the result's
    // prototype (prototype pollution).
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * Deep-copy a value into owned, frozen, plain JSON data. Throws via `fail`
 * on non-JSON shapes. Delegates to the workspace's one JSON walker so the
 * accessor/symbol/prototype rules stay in exactly one place.
 */
export function snapshotJson(
  value: unknown,
  options: { readonly path: string; readonly fail: (failure: SnapshotFailure) => never },
): JsonValue {
  try {
    return normalizeJson(value, options.path);
  } catch (error) {
    if (error instanceof JsonError) {
      const prefix = `${error.code} at ${error.path}: `;
      return options.fail({
        code: error.code,
        path: error.path,
        message: error.message.startsWith(prefix)
          ? error.message.slice(prefix.length)
          : error.message,
      });
    }
    throw error;
  }
}

/** Structural JSON equality by canonical form. */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
