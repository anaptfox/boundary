import { z } from "zod";
import { type JsonValue } from "./json";
import { compileSchema, type SchemaAdapter, type SchemaCompilation, type SchemaCompilationContext, type SchemaRole } from "./schema";
import { validateZodNode } from "./zod-validate";
import { SchemaCompilationError, isPlainObject, jsonValue } from "./zod-json";

const ASSERTION_KEYS = new Set([
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

const PATTERN_FORMATS = new Set(["uuid", "email"]);

const ANNOTATION_KEYS = new Set([
  "title",
  "description",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "role",
  "control",
]);

/**
 * Strip only Zod's non-enumerable Standard Schema implementation property.
 * Not routed through `exactObject`: that kernel has no "drop exactly this one
 * non-enumerable key, then strictly walk the rest" mode, and adding one for a
 * single third-party quirk doesn't belong in a general-purpose walker.
 */
function generatedSchemaValue(value: unknown, path: string): JsonValue {
  if (!isPlainObject(value)) return jsonValue(value, path);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new SchemaCompilationError(
      "SCHEMA_NON_JSON_VALUE",
      path,
      "schema properties could not be inspected",
    );
  }
  const visible: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new SchemaCompilationError(
        "SCHEMA_NON_JSON_VALUE",
        path,
        "schema contains a symbol-keyed property",
      );
    }
    const isEnum = Object.prototype.propertyIsEnumerable.call(value, key);
    if (key === "~standard" && !isEnum) continue;
    if (!isEnum) {
      throw new SchemaCompilationError(
        "SCHEMA_NON_JSON_VALUE",
        `${path}.${key}`,
        "schema properties must be enumerable",
      );
    }
    visible[key] = (value as Record<string, unknown>)[key];
  }
  return jsonValue(visible, path);
}

function splitSchema(
  value: unknown,
  path: string,
): { contract?: JsonValue; annotations?: JsonValue } {
  if (Array.isArray(value)) {
    const children = value.map((item, index) =>
      splitSchema(item, `${path}[${index}]`),
    );
    return {
      contract: children.map((child) => child.contract ?? null),
      ...(children.some((child) => child.annotations !== undefined)
        ? { annotations: children.map((child) => child.annotations ?? null) }
        : {}),
    };
  }
  if (!isPlainObject(value)) return { contract: jsonValue(value, path) };

  const contract: Record<string, JsonValue> = {};
  const annotations: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "$schema") continue;
    // Zod checks uuid and email with exactly the pattern it also emits, so the
    // pattern alone is the contract.
    if (key === "format" && PATTERN_FORMATS.has(item as string) && typeof value.pattern === "string") continue;
    if (key === "format" || key === "$ref" || key === "$defs") {
      throw new SchemaCompilationError(
        "SCHEMA_UNSUPPORTED_KEYWORD",
        itemPath,
        `${key} is not in the portable schema profile`,
      );
    }
    if (ANNOTATION_KEYS.has(key)) {
      annotations[key] = jsonValue(item, itemPath);
      continue;
    }
    if (!ASSERTION_KEYS.has(key)) {
      throw new SchemaCompilationError(
        "SCHEMA_UNSUPPORTED_KEYWORD",
        itemPath,
        `${key} is not in the portable schema profile`,
      );
    }
    if (key === "properties" && isPlainObject(item)) {
      const contractProperties: Record<string, JsonValue> = {};
      const annotationProperties: Record<string, JsonValue> = {};
      for (const [name, property] of Object.entries(item)) {
        const split = splitSchema(property, `${itemPath}.${name}`);
        if (split.contract !== undefined) contractProperties[name] = split.contract;
        if (split.annotations !== undefined) {
          annotationProperties[name] = split.annotations;
        }
      }
      contract.properties = contractProperties;
      if (Object.keys(annotationProperties).length > 0) {
        annotations.properties = annotationProperties;
      }
      continue;
    }
    const split = splitSchema(item, itemPath);
    if (split.contract !== undefined) contract[key] = split.contract;
    if (split.annotations !== undefined) annotations[key] = split.annotations;
  }
  // Zod emits a type array for unconstrained nullable primitives. Boundary's
  // portable profile uses alternatives instead. Keep sibling assertions at
  // this schema level: moving them only into a non-null branch could weaken
  // enum/const/combinator constraints that also apply to null.
  if (Array.isArray(contract.type)) {
    const types = contract.type;
    const supported = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
    if (types.length === 0 || types.some(type => typeof type !== "string" || !supported.has(type)) || new Set(types).size !== types.length) {
      throw new SchemaCompilationError("SCHEMA_NOT_PORTABLE", `${path}.type`, "generated type arrays must contain distinct supported JSON type names");
    }
    delete contract.type;
    const alternatives = types.map(type => ({ type }));
    if (contract.anyOf === undefined) contract.anyOf = alternatives;
    else {
      if (contract.allOf !== undefined && !Array.isArray(contract.allOf)) {
        throw new SchemaCompilationError("SCHEMA_NOT_PORTABLE", `${path}.allOf`, "generated allOf must remain an array of schemas");
      }
      contract.allOf = [...(contract.allOf ?? []), { anyOf: alternatives }];
    }
  }
  // Object keys are always strings, so `propertyNames: { type: "string" }`
  // (a plain z.record key) asserts nothing. Dropping it gives the record the
  // contract a native string-keyed map already has.
  if (
    isPlainObject(contract.propertyNames) &&
    Object.keys(contract.propertyNames).length === 1 &&
    contract.propertyNames.type === "string"
  ) {
    delete contract.propertyNames;
  }
  return {
    contract,
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
  };
}

function compileZod(
  schema: z.ZodType,
  context: SchemaCompilationContext,
): { readonly contract: unknown; readonly annotations: unknown } {
  validateZodNode(schema, context.path);
  let generated: unknown;
  try {
    generated = z.toJSONSchema(schema, {
      // Contracts describe the exact portable value a realization receives.
      // Boundary rejects defaults/coercions/stripping at runtime, so use Zod's
      // post-parse shape for every contract role.
      io: "output",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemaCompilationError(
      "SCHEMA_NOT_PORTABLE",
      context.path,
      message,
    );
  }
  const split = splitSchema(
    generatedSchemaValue(generated, context.path),
    context.path,
  );
  if (!isPlainObject(split.contract)) {
    throw new SchemaCompilationError(
      "SCHEMA_NOT_OBJECT",
      context.path,
      "compiled schema must be an object",
    );
  }
  return {
    contract: split.contract,
    annotations: isPlainObject(split.annotations) ? split.annotations : {},
  };
}

/** Built-in browser-safe adapter for Zod 4 schemas. */
export const zodSchemaAdapter: SchemaAdapter<z.ZodType> & Readonly<{
  supports(value: unknown): value is z.ZodType;
}> = Object.freeze({
  compile: compileZod,
  supports(value: unknown): value is z.ZodType {
    return value !== null && typeof value === "object" && "_zod" in value;
  },
});

export function compileZodSchema(
  schema: z.ZodType,
  role: SchemaRole,
  path: string,
): SchemaCompilation {
  return compileSchema(schema, zodSchemaAdapter, { role, path });
}

export { SchemaCompilationError, jsonValue, type SchemaCompilationDiagnosticCode } from "./zod-json";
