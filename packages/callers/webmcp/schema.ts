import type { JsonValue } from "@foxworth/boundary/program";

const SAFE_ANNOTATION_KEYS = new Set([
  "title",
  "description",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function snapshot(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Recursively overlay safe JSON Schema annotations. Drops `role` and `control`. */
export function overlayInputSchema(
  contract: JsonValue,
  annotations: JsonValue | undefined,
): JsonValue {
  if (!isPlainObject(contract)) return snapshot(contract);
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(contract)) {
    result[key] = snapshot(value as JsonValue);
  }
  if (!isPlainObject(annotations)) return result;

  for (const key of SAFE_ANNOTATION_KEYS) {
    if (key in annotations && annotations[key] !== undefined) {
      result[key] = snapshot(annotations[key] as JsonValue);
    }
  }

  if (isPlainObject(contract.properties)) {
    const annotationProperties = isPlainObject(annotations.properties)
      ? annotations.properties
      : {};
    result.properties = Object.fromEntries(
      Object.entries(contract.properties).map(([name, schema]) => [
        name,
        overlayInputSchema(
          schema as JsonValue,
          annotationProperties[name] as JsonValue | undefined,
        ),
      ]),
    );
  }

  if ("items" in contract && contract.items !== undefined) {
    result.items = overlayInputSchema(
      contract.items as JsonValue,
      isPlainObject(annotations) ? (annotations.items as JsonValue | undefined) : undefined,
    );
  }

  if (isPlainObject(contract.additionalProperties)) {
    result.additionalProperties = overlayInputSchema(
      contract.additionalProperties as JsonValue,
      isPlainObject(annotations.additionalProperties)
        ? (annotations.additionalProperties as JsonValue)
        : undefined,
    );
  }

  return result;
}

export function isObjectInputSchema(schema: unknown): schema is Record<string, unknown> {
  return isPlainObject(schema) && schema.type === "object";
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(value);
}
