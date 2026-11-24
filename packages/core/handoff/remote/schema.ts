import {
  PortableSchemaError,
  normalizeJson,
  validatePortableSchema,
  validateSchemaValue,
  type JsonSchema,
  type JsonValue,
} from "@foxworth/boundary/program";
import { AdapterError } from "./errors";

function portableSchema(schema: JsonSchema, path: string): JsonSchema {
  try {
    const normalized = normalizeJson(schema, path);
    if (
      normalized === null ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    ) {
      throw new AdapterError(
        "UNSUPPORTED_SCHEMA",
        path,
        "a portable schema must be a JSON object",
      );
    }
    const object = normalized as JsonSchema;
    validatePortableSchema(object, path);
    return object;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (error instanceof PortableSchemaError) {
      throw new AdapterError("UNSUPPORTED_SCHEMA", error.path, error.message);
    }
    throw new AdapterError(
      "UNSUPPORTED_SCHEMA",
      path,
      "schema is not portable JSON",
    );
  }
}

/** Normalize and validate one value against Program's canonical schema profile. */
export function validatePortableValue(
  schema: JsonSchema,
  value: unknown,
  path = "value",
): JsonValue {
  const normalizedSchema = portableSchema(schema, `${path}.schema`);
  let normalized: JsonValue;
  try {
    normalized = normalizeJson(value, path);
  } catch {
    throw new AdapterError(
      "SCHEMA_MISMATCH",
      path,
      "value is not portable JSON",
    );
  }
  const issues = validateSchemaValue(normalizedSchema, normalized, path);
  if (issues.length > 0) {
    throw new AdapterError(
      "SCHEMA_MISMATCH",
      issues[0]!.path,
      issues[0]!.message,
    );
  }
  return normalized;
}
