import { BoundaryErrorBase } from "./errors";
import {
  canonicalJson,
  isOwnedJson,
  normalizeJson,
  type JsonArray,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "./json";

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "propertyNames",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

const TYPES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);

export type PortableSchemaDiagnosticCode =
  | "SCHEMA_CONTRACT_INVALID"
  | "SCHEMA_UNSUPPORTED_KEYWORD";

export class PortableSchemaError extends BoundaryErrorBase {
  declare readonly code: PortableSchemaDiagnosticCode;

  constructor(
    code: PortableSchemaDiagnosticCode,
    path: string,
    message: string,
  ) {
    super(code, path, message);
    this.name = "PortableSchemaError";
  }
}

export type SchemaValueIssue = {
  readonly path: string;
  readonly message: string;
};

declare const portableSchemaValue: unique symbol;
const portableSchemas = new WeakSet<object>();
/** Only validated, owned immutable snapshots are trusted by identity. */
const validatedSchemas = new WeakSet<object>();

/** A literal portable schema carrying the JSON value type it describes. */
export type PortableSchema<Value extends JsonValue = JsonValue> = JsonSchema & {
  readonly [portableSchemaValue]: Value;
};

export type PortableSchemaValue<Schema extends PortableSchema> =
  Schema[typeof portableSchemaValue];

/** Recognize only schemas returned by portableSchema(), without branding JSON. */
export function isPortableSchema(value: unknown): value is PortableSchema {
  return value !== null && typeof value === "object" && portableSchemas.has(value);
}

function fail(
  code: PortableSchemaDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new PortableSchemaError(code, path, message);
}

export function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function expectObject(
  value: JsonValue | undefined,
  path: string,
  label: string,
): JsonObject {
  if (value === undefined || !isObject(value)) {
    fail("SCHEMA_CONTRACT_INVALID", path, `${label} must be a schema object`);
  }
  return value;
}

function expectArray(
  value: JsonValue | undefined,
  path: string,
  label: string,
): JsonArray {
  if (!Array.isArray(value)) {
    fail("SCHEMA_CONTRACT_INVALID", path, `${label} must be an array`);
  }
  return value;
}

function expectNonnegativeInteger(
  value: JsonValue | undefined,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(
      "SCHEMA_CONTRACT_INVALID",
      path,
      "keyword value must be a non-negative integer",
    );
  }
  return value;
}

function validateAlternatives(
  value: JsonValue | undefined,
  path: string,
  keyword: string,
): void {
  const alternatives = expectArray(value, path, keyword);
  if (alternatives.length === 0) {
    fail(
      "SCHEMA_CONTRACT_INVALID",
      path,
      `${keyword} must contain at least one schema`,
    );
  }
  alternatives.forEach((alternative, index) => {
    validatePortableSchema(
      expectObject(alternative, `${path}[${index}]`, keyword),
      `${path}[${index}]`,
    );
  });
}

/** Validate Boundary's bounded, executable JSON Schema profile. */
export function validatePortableSchema(
  schema: JsonSchema,
  path = "schema",
): void {
  if (validatedSchemas.has(schema)) return;
  if (!isOwnedJson(schema)) {
    validatePortableSchema(normalizeJson(schema, path) as JsonSchema, path);
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) {
      fail(
        "SCHEMA_UNSUPPORTED_KEYWORD",
        propertyPath(path, keyword),
        `${keyword} is not in Boundary's portable schema profile`,
      );
    }
  }

  if (schema.type !== undefined) {
    if (typeof schema.type !== "string" || !TYPES.has(schema.type)) {
      fail(
        "SCHEMA_CONTRACT_INVALID",
        `${path}.type`,
        "type must be one supported JSON type name",
      );
    }
  }

  if (schema.properties !== undefined) {
    const properties = expectObject(
      schema.properties,
      `${path}.properties`,
      "properties",
    );
    for (const [name, property] of Object.entries(properties)) {
      const itemPath = propertyPath(`${path}.properties`, name);
      validatePortableSchema(expectObject(property, itemPath, "property"), itemPath);
    }
  }

  if (schema.required !== undefined) {
    const required = expectArray(schema.required, `${path}.required`, "required");
    const seen = new Set<string>();
    for (const [index, name] of required.entries()) {
      if (typeof name !== "string" || seen.has(name)) {
        fail(
          "SCHEMA_CONTRACT_INVALID",
          `${path}.required[${index}]`,
          "required entries must be unique strings",
        );
      }
      seen.add(name);
    }
  }

  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean") {
      validatePortableSchema(
        expectObject(
          schema.additionalProperties,
          `${path}.additionalProperties`,
          "additionalProperties",
        ),
        `${path}.additionalProperties`,
      );
    }
  }

  // `items: false` closes a tuple after `prefixItems`; `items: true` is the
  // absent keyword spelled differently and stays outside the profile.
  if (schema.items !== undefined && schema.items !== false) {
    validatePortableSchema(
      expectObject(schema.items, `${path}.items`, "items"),
      `${path}.items`,
    );
  }

  if (schema.prefixItems !== undefined) {
    validateAlternatives(schema.prefixItems, `${path}.prefixItems`, "prefixItems");
  }

  if (schema.propertyNames !== undefined) {
    validatePortableSchema(
      expectObject(schema.propertyNames, `${path}.propertyNames`, "propertyNames"),
      `${path}.propertyNames`,
    );
  }

  if (
    schema.uniqueItems !== undefined &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    fail(
      "SCHEMA_CONTRACT_INVALID",
      `${path}.uniqueItems`,
      "uniqueItems must be a boolean",
    );
  }

  if (schema.enum !== undefined) {
    const values = expectArray(schema.enum, `${path}.enum`, "enum");
    if (values.length === 0) {
      fail("SCHEMA_CONTRACT_INVALID", `${path}.enum`, "enum must not be empty");
    }
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = canonicalJson(value);
      if (seen.has(key)) {
        fail(
          "SCHEMA_CONTRACT_INVALID",
          `${path}.enum[${index}]`,
          "enum values must be unique",
        );
      }
      seen.add(key);
    }
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (schema[keyword] !== undefined) {
      validateAlternatives(schema[keyword], `${path}.${keyword}`, keyword);
    }
  }

  if (schema.not !== undefined) {
    validatePortableSchema(
      expectObject(schema.not, `${path}.not`, "not"),
      `${path}.not`,
    );
  }

  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ] as const) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "number") {
      fail(
        "SCHEMA_CONTRACT_INVALID",
        `${path}.${keyword}`,
        `${keyword} must be a finite number`,
      );
    }
  }

  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ] as const) {
    if (schema[keyword] !== undefined) {
      expectNonnegativeInteger(schema[keyword], `${path}.${keyword}`);
    }
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      fail(
        "SCHEMA_CONTRACT_INVALID",
        `${path}.pattern`,
        "pattern must be a string",
      );
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      fail(
        "SCHEMA_CONTRACT_INVALID",
        `${path}.pattern`,
        "pattern must be a valid Unicode ECMAScript regular expression",
      );
    }
  }

  if (
    typeof schema.minLength === "number" &&
    typeof schema.maxLength === "number" &&
    schema.minLength > schema.maxLength
  ) {
    fail(
      "SCHEMA_CONTRACT_INVALID",
      path,
      "minLength must not exceed maxLength",
    );
  }
  if (
    typeof schema.minItems === "number" &&
    typeof schema.maxItems === "number" &&
    schema.minItems > schema.maxItems
  ) {
    fail(
      "SCHEMA_CONTRACT_INVALID",
      path,
      "minItems must not exceed maxItems",
    );
  }
  validatedSchemas.add(schema);
}

/** Whether `schema` has already passed validatePortableSchema by identity. */
export function hasValidatedSchema(schema: object): boolean {
  return validatedSchemas.has(schema);
}

/**
 * Author a literal schema without a runtime-specific adapter. The returned
 * schema is normalized portable JSON and deeply frozen.
 */
export function portableSchema<Value extends JsonValue = JsonValue>(
  schema: JsonSchema,
  path = "schema",
): PortableSchema<Value> {
  const normalized = normalizeJson(schema, path);
  if (!isObject(normalized)) {
    fail("SCHEMA_CONTRACT_INVALID", path, "schema must be an object");
  }
  validatePortableSchema(normalized, path);
  portableSchemas.add(normalized);
  return normalized as PortableSchema<Value>;
}
