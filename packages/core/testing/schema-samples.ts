import type { JsonSchema, JsonValue } from "@foxworth/boundary/program";
import { validateSchemaValue } from "@foxworth/boundary/program";

const obj = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function unique(values: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function generateValidSamples(schema: JsonSchema, options: { maxSamples?: number } = {}): readonly JsonValue[] {
  const limit = Math.max(0, options.maxSamples ?? 64);
  const s = schema as Record<string, JsonValue>;
  let values: JsonValue[] = [];
  if (Array.isArray(s.enum)) values.push(...s.enum);
  if (Object.hasOwn(s, "const")) values.push(s.const!);
  if (Array.isArray(s.anyOf)) values.push(...s.anyOf.flatMap((x) => obj(x) ? [...generateValidSamples(x)] : []));
  if (Array.isArray(s.oneOf)) values.push(...s.oneOf.flatMap((x) => obj(x) ? [...generateValidSamples(x)] : []));
  const types = Array.isArray(s.type) ? s.type : [s.type];
  for (const type of types) {
    if (type === "string") {
      const min = typeof s.minLength === "number" ? s.minLength : 0;
      const max = typeof s.maxLength === "number" ? s.maxLength : Math.max(min, 8);
      values.push("", "x".repeat(min), "x".repeat(Math.min(max, Math.max(min, 1))));
    } else if (type === "number" || type === "integer") {
      for (const value of [0, 1, s.minimum, s.maximum,
        typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum + (type === "integer" ? 1 : 0.5) : undefined,
        typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum - (type === "integer" ? 1 : 0.5) : undefined]) {
        if (typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value))) values.push(value);
      }
    } else if (type === "boolean") values.push(true, false);
    else if (type === "null") values.push(null);
    else if (type === "array") {
      const min = typeof s.minItems === "number" ? s.minItems : 0;
      const itemSchema = obj(s.items) ? s.items as JsonSchema : {};
      const item = generateValidSamples(itemSchema, { maxSamples: 1 })[0] ?? null;
      values.push(Array.from({ length: min }, () => item), Array.from({ length: Math.max(min, 1) }, () => item));
      if (Array.isArray(s.prefixItems)) values.push(s.prefixItems.map((x) => obj(x) ? generateValidSamples(x, { maxSamples: 1 })[0] ?? null : null));
    } else if (type === "object" || s.properties !== undefined) {
      const properties = obj(s.properties) ? s.properties : {};
      const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : [];
      const requiredOnly: Record<string, JsonValue> = {};
      const all: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(properties)) {
        const sample = obj(value) ? generateValidSamples(value).find((candidate) => validateSchemaValue(value as JsonSchema, candidate).length === 0) ?? null : null;
        all[key] = sample;
        if (required.includes(key)) requiredOnly[key] = sample;
      }
      values.push(requiredOnly, all);
    }
  }
  return Object.freeze(unique(values).slice(0, limit));
}

export function generateInvalidSamples(schema: JsonSchema): readonly JsonValue[] {
  const s = schema as Record<string, JsonValue>;
  const values: JsonValue[] = [];
  const type = s.type;
  if (type === "string") {
    if (typeof s.minLength === "number" && s.minLength > 0) values.push("x".repeat(s.minLength - 1));
    if (typeof s.maxLength === "number") values.push("x".repeat(s.maxLength + 1));
    values.push(1, null);
  } else if (type === "number" || type === "integer") {
    if (typeof s.minimum === "number") values.push(s.minimum - 1);
    if (typeof s.maximum === "number") values.push(s.maximum + 1);
    if (type === "integer") values.push(0.5);
    values.push("1", null);
  } else if (type === "boolean") values.push("true", 0);
  else if (type === "null") values.push(false, 0);
  else if (type === "array") values.push({}, "array");
  else if (type === "object" || s.properties !== undefined) {
    const props = obj(s.properties) ? s.properties : {};
    const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : [];
    const candidate: Record<string, JsonValue> = {};
    for (const key of required) candidate[key] = obj(props[key]!) ? generateValidSamples(props[key] as JsonSchema, { maxSamples: 1 })[0] ?? null : null;
    if (required.length) values.push({});
    if (s.additionalProperties === false) values.push({ ...candidate, __unexpected: true });
    values.push(null, []);
  } else values.push("invalid", null);
  if (Array.isArray(s.enum)) values.push("__not_in_enum__");
  if (Object.hasOwn(s, "const")) values.push("__not_const__");
  return Object.freeze(unique(values));
}
