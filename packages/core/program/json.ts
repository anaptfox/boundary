import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { BoundaryErrorBase } from "./errors";

// Only snapshots created here can be trusted by internal identity caches.
const ownedJson = new WeakSet<object>();
// Metadata lives only as long as its owned object; payload strings are not cached.
const ownedObjectKeys = new WeakMap<object, readonly string[]>();
export function isOwnedJson(value: object): boolean {
  return ownedJson.has(value);
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonSchema = JsonObject;

export type Sha256Digest = `sha256:${string}`;
export type DomainHasher = (
  domain: string,
  value: JsonValue,
) => Sha256Digest;

/** Stable failures at Boundary's portable JSON seam. */
export type JsonDiagnosticCode =
  | "JSON_ACCESSOR_PROPERTY"
  | "JSON_ARRAY_HOLE"
  | "JSON_CYCLIC_REFERENCE"
  | "JSON_INSPECTION_FAILED"
  | "JSON_INVALID_UNICODE"
  | "JSON_NON_ENUMERABLE_PROPERTY"
  | "JSON_NON_FINITE_NUMBER"
  | "JSON_NON_PLAIN_OBJECT"
  | "JSON_SYMBOL_KEY"
  | "JSON_UNDEFINED"
  | "JSON_UNSUPPORTED_PROPERTY"
  | "JSON_UNSUPPORTED_TYPE"
  | "HASH_INVALID_DOMAIN"
  | "HASH_SHA256_UNAVAILABLE";

export class JsonError extends BoundaryErrorBase {
  declare readonly code: JsonDiagnosticCode;

  constructor(code: JsonDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "JsonError";
  }
}

const encoder = new TextEncoder();
// Unicode mode reads valid surrogate pairs as one supplementary code point.
const unpairedSurrogate = /[\ud800-\udfff]/u;

function fail(
  code: JsonDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new JsonError(code, path, message);
}

/** Compare strings by UTF-8 bytes, independent of locale and runtime. */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const units = Math.min(left.length, right.length);
  for (let index = 0; index < units; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a >= 0x80 || b >= 0x80) break;
    if (a !== b) return a - b;
  }
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function assertUnicodeScalarString(value: string, path: string): void {
  if (unpairedSurrogate.test(value)) {
    fail(
      "JSON_INVALID_UNICODE",
      path,
      "strings must not contain an unpaired UTF-16 surrogate",
    );
  }
}

function prototypeOf(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    return fail(
      "JSON_INSPECTION_FAILED",
      path,
      "object prototype could not be inspected",
    );
  }
}

function ownKeys(value: object, path: string): readonly (string | symbol)[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return fail(
      "JSON_INSPECTION_FAILED",
      path,
      "object properties could not be inspected",
    );
  }
}

function descriptorOf(
  value: object,
  key: PropertyKey,
  path: string,
): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor) return descriptor;
  } catch {
    // Report a stable diagnostic rather than proxy/runtime wording.
  }
  return fail(
    "JSON_INSPECTION_FAILED",
    path,
    "object property could not be inspected",
  );
}

function assertDataProperty(
  descriptor: PropertyDescriptor,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (!("value" in descriptor)) {
    fail(
      "JSON_ACCESSOR_PROPERTY",
      path,
      "JSON properties must be data properties, not getters or setters",
    );
  }
  if (!descriptor.enumerable) {
    fail(
      "JSON_NON_ENUMERABLE_PROPERTY",
      path,
      "JSON properties must be enumerable",
    );
  }
}

function normalizeArray(
  value: readonly unknown[],
  path: string,
  active: WeakSet<object>,
): JsonArray {
  if (prototypeOf(value, path) !== Array.prototype) {
    fail(
      "JSON_NON_PLAIN_OBJECT",
      path,
      "JSON arrays must use the built-in Array prototype",
    );
  }
  const keys = ownKeys(value, path);
  const elementKeys = new Set<string>();
  for (const key of keys) {
    if (typeof key === "symbol") {
      fail(
        "JSON_SYMBOL_KEY",
        path,
        "JSON arrays must not have symbol-keyed properties",
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      fail(
        "JSON_UNSUPPORTED_PROPERTY",
        propertyPath(path, key),
        "JSON arrays must not have properties other than their elements",
      );
    }
    elementKeys.add(key);
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    if (!elementKeys.has(String(index))) {
      fail("JSON_ARRAY_HOLE", itemPath, "JSON arrays must not contain holes");
    }
    const descriptor = descriptorOf(value, String(index), itemPath);
    assertDataProperty(descriptor, itemPath);
    result.push(normalize(descriptor.value, itemPath, active));
  }
  Object.freeze(result);
  ownedJson.add(result);
  return result;
}

function normalizeObject(
  value: object,
  path: string,
  active: WeakSet<object>,
): JsonObject {
  const prototype = prototypeOf(value, path);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(
      "JSON_NON_PLAIN_OBJECT",
      path,
      "JSON objects must be plain objects",
    );
  }

  const keys = ownKeys(value, path);
  for (const key of keys) {
    if (typeof key === "symbol") {
      fail(
        "JSON_SYMBOL_KEY",
        path,
        "JSON objects must not have symbol-keyed properties",
      );
    }
    assertUnicodeScalarString(key, propertyPath(path, key));
  }

  const sortedKeys = Object.freeze([...(keys as readonly string[])].sort(compareUtf8));
  const result: Record<string, JsonValue> = {};
  for (const key of sortedKeys) {
    const itemPath = propertyPath(path, key);
    const descriptor = descriptorOf(value, key, itemPath);
    assertDataProperty(descriptor, itemPath);
    Object.defineProperty(result, key, {
      value: normalize(descriptor.value, itemPath, active),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  Object.freeze(result);
  ownedJson.add(result);
  ownedObjectKeys.set(result, sortedKeys);
  return result;
}

/** Copy data proved by this module without changing fresh-copy semantics. */
function copyOwned(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(copyOwned(value[index]!));
    }
    Object.freeze(result);
    ownedJson.add(result);
    return result;
  }
  const object = value as JsonObject;
  const keys = ownedObjectKeys.get(object)!;
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    Object.defineProperty(result, key, {
      value: copyOwned(object[key]!),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  Object.freeze(result);
  ownedJson.add(result);
  ownedObjectKeys.set(result, keys);
  return result;
}

function normalize(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("JSON_NON_FINITE_NUMBER", path, "JSON numbers must be finite");
    }
    return value === 0 ? 0 : value;
  }
  if (value === undefined) {
    return fail("JSON_UNDEFINED", path, "undefined is not a JSON value");
  }
  if (typeof value !== "object") {
    return fail(
      "JSON_UNSUPPORTED_TYPE",
      path,
      `${typeof value} is not a JSON value`,
    );
  }
  if (ownedJson.has(value)) return copyOwned(value as JsonValue);
  if (active.has(value)) {
    return fail(
      "JSON_CYCLIC_REFERENCE",
      path,
      "cyclic references are not JSON values",
    );
  }

  active.add(value);
  try {
    return Array.isArray(value)
      ? normalizeArray(value, path, active)
      : normalizeObject(value, path, active);
  } finally {
    active.delete(value);
  }
}

/**
 * Validate, canonicalize, clone, and deeply freeze one portable JSON value.
 * Optional data is absent; explicit `undefined` is rejected.
 */
export function normalizeJson(value: unknown, path = "$"): JsonValue {
  return normalize(value, path, new WeakSet());
}

function canonical(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as JsonObject;
  return `{${ownedObjectKeys.get(object)!
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
    .join(",")}}`;
}

/** Stable JSON for identity and language-neutral conformance vectors. */
export function canonicalJson(value: JsonValue): string {
  const owned = value !== null && typeof value === "object" && ownedJson.has(value);
  return canonical(owned ? value : normalizeJson(value));
}

export function cloneJson<T extends JsonValue>(value: T, path = "$"): T {
  return normalizeJson(value, path) as T;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

const HEX_BYTES = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

/** Hash canonical JSON in an explicit domain separated by a NUL byte. */
export function hashJson(
  domain: string,
  value: JsonValue,
): Sha256Digest {
  if (!domain.trim() || domain.includes("\0")) {
    fail(
      "HASH_INVALID_DOMAIN",
      "domain",
      "hash domain must be non-empty and cannot contain NUL",
    );
  }
  const bytes = encoder.encode(`${domain}\0${canonicalJson(value)}`);
  const digest = nobleSha256(bytes);
  let hex = "sha256:";
  for (let i = 0; i < digest.length; i += 1) {
    hex += HEX_BYTES[digest[i]!];
  }
  return hex as Sha256Digest;
}

/** Generic canonical-JSON hash; Boundary protocol identities use explicit domains. */
export function sha256(value: JsonValue): Sha256Digest {
  return hashJson("canonical-json/v1", value);
}
