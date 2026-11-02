import { type JsonObject } from "@foxworth/boundary/program";
import { isInteractionDefinition } from "./definitions";
import { failHost } from "./errors";
import type { AnyInteractionDefinition } from "./types";

export function descriptorAnnotations(
  definition: AnyInteractionDefinition,
  schemas: Readonly<{
    input: JsonObject;
    output: JsonObject;
    errors: JsonObject;
  }>,
): JsonObject | undefined {
  const schemaAnnotations: Record<string, JsonObject> = {};
  if (Object.keys(schemas.input).length > 0) {
    schemaAnnotations.input = schemas.input;
  }
  if (Object.keys(schemas.output).length > 0) {
    schemaAnnotations.output = schemas.output;
  }
  if (Object.keys(schemas.errors).length > 0) {
    schemaAnnotations.errors = schemas.errors;
  }
  if (
    definition.annotations === undefined &&
    Object.keys(schemaAnnotations).length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    ...definition.annotations,
    ...(Object.keys(schemaAnnotations).length === 0
      ? {}
      : { schemas: Object.freeze(schemaAnnotations) }),
  });
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost(
      "INVALID_DEFINITION_COLLECTION",
      path,
      "interactions must be a plain record",
    );
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch (cause) {
    return failHost(
      "INVALID_DEFINITION_COLLECTION",
      path,
      "interactions could not be inspected",
      cause,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return failHost(
      "INVALID_DEFINITION_COLLECTION",
      path,
      "interactions must use a plain-object prototype",
    );
  }
  return value as Record<string, unknown>;
}

export function dataEntries(
  value: unknown,
  path: string,
): readonly (readonly [string, unknown])[] {
  const record = plainRecord(value, path);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(record);
  } catch (cause) {
    return failHost(
      "INVALID_DEFINITION_COLLECTION",
      path,
      "interaction keys could not be inspected",
      cause,
    );
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
      failHost(
        "INVALID_DEFINITION_COLLECTION",
        `${path}.${String(key)}`,
        "interaction aliases must be JavaScript identifier-like strings",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      failHost(
        "INVALID_DEFINITION_COLLECTION",
        `${path}.${key}`,
        "interaction entries must be enumerable data properties",
      );
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function snapshotDefinitions(
  value: unknown,
  path = "interactions",
): Readonly<Record<string, AnyInteractionDefinition>> {
  const result: Record<string, AnyInteractionDefinition> = {};
  for (const [alias, definition] of dataEntries(value, path)) {
    if (!isInteractionDefinition(definition)) {
      failHost(
        "FORGED_DEFINITION",
        `${path}.${alias}`,
        "interaction collections may contain only authentic defineInteraction values",
      );
    }
    Object.defineProperty(result, alias, {
      value: definition,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(result);
}
