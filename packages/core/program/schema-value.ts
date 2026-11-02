import { canonicalJson, normalizeJson, type JsonSchema, type JsonValue } from "./json";
import { jsonEquals } from "./snapshot";
import {
  hasValidatedSchema,
  isObject,
  propertyPath,
  validatePortableSchema,
  type SchemaValueIssue,
} from "./validation";

type CompiledSchema = Readonly<{
  schema: JsonSchema;
  pattern: RegExp | undefined;
  properties: ReadonlyMap<string, CompiledSchema>;
  required: ReadonlySet<string>;
  anyOf: readonly CompiledSchema[] | undefined;
  oneOf: readonly CompiledSchema[] | undefined;
  allOf: readonly CompiledSchema[] | undefined;
  not: CompiledSchema | undefined;
  items: CompiledSchema | undefined;
  prefixItems: readonly CompiledSchema[] | undefined;
  propertyNames: CompiledSchema | undefined;
  additional: CompiledSchema | undefined;
}>;
const compiledSchemas = new WeakMap<object, CompiledSchema>();

function compile(schema: JsonSchema): CompiledSchema {
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;
  const branch = (value: JsonValue | undefined) =>
    isObject(value as JsonValue) ? compile(value as JsonSchema) : undefined;
  const branches = (value: JsonValue | undefined) =>
    Array.isArray(value) ? value.map((item) => compile(item as JsonSchema)) : undefined;
  const compiled: CompiledSchema = Object.freeze({
    schema,
    pattern: typeof schema.pattern === "string" ? new RegExp(schema.pattern, "u") : undefined,
    properties: new Map(Object.entries(isObject(schema.properties as JsonValue) ? schema.properties! : {})
      .map(([name, value]) => [name, compile(value as JsonSchema)])),
    required: new Set(Array.isArray(schema.required) ? schema.required as string[] : []),
    anyOf: branches(schema.anyOf),
    oneOf: branches(schema.oneOf),
    allOf: branches(schema.allOf),
    not: branch(schema.not),
    items: branch(schema.items),
    prefixItems: branches(schema.prefixItems),
    propertyNames: branch(schema.propertyNames),
    additional: branch(schema.additionalProperties),
  });
  compiledSchemas.set(schema, compiled);
  return compiled;
}

function valueTypeMatches(type: string, value: JsonValue): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function valueIssues(
  compiled: CompiledSchema,
  value: JsonValue,
  path: string,
): SchemaValueIssue[] {
  const { schema } = compiled;
  const issues: SchemaValueIssue[] = [];
  const issue = (message: string, issuePath = path) => {
    issues.push(Object.freeze({ path: issuePath, message }));
  };

  if (typeof schema.type === "string" && !valueTypeMatches(schema.type, value)) {
    issue(`value must have JSON type ${schema.type}`);
    return issues;
  }
  if (schema.const !== undefined && !jsonEquals(schema.const, value)) {
    issue("value must equal const");
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEquals(candidate, value))
  ) {
    issue("value must be one of enum");
  }

  if (compiled.anyOf && !compiled.anyOf.some((candidate) => valueIssues(candidate, value, path).length === 0)) {
    issue("value must match at least one anyOf schema");
  }
  if (compiled.oneOf) {
    let matches = 0;
    for (const candidate of compiled.oneOf) {
      if (valueIssues(candidate, value, path).length === 0 && ++matches === 2) break;
    }
    if (matches !== 1) issue("value must match exactly one oneOf schema");
  }
  if (compiled.allOf) {
    for (const candidate of compiled.allOf) issues.push(...valueIssues(candidate, value, path));
  }
  if (compiled.not && valueIssues(compiled.not, value, path).length === 0) {
    issue("value must not match the excluded schema");
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issue(`number must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issue(`number must be at most ${schema.maximum}`);
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      issue(`number must be greater than ${schema.exclusiveMinimum}`);
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      issue(`number must be less than ${schema.exclusiveMaximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
      let length = 0;
      for (const _ of value) length += 1;
      if (typeof schema.minLength === "number" && length < schema.minLength) {
        issue(`string must contain at least ${schema.minLength} code points`);
      }
      if (typeof schema.maxLength === "number" && length > schema.maxLength) {
        issue(`string must contain at most ${schema.maxLength} code points`);
      }
    }
    const pattern = compiled.pattern;
    if (pattern && !pattern.test(value)) {
      issue("string must match pattern");
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issue(`array must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issue(`array must contain at most ${schema.maxItems} items`);
    }
    const prefix = compiled.prefixItems ?? [];
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      const positional = prefix[index];
      if (positional) {
        issues.push(...valueIssues(positional, item, itemPath));
      } else if (schema.items === false) {
        issue("array item is not allowed after prefixItems", itemPath);
      } else if (compiled.items) {
        issues.push(...valueIssues(compiled.items, item, itemPath));
      }
    });
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((item, index) => {
        const key = canonicalJson(item);
        if (seen.has(key)) {
          issue("array items must be unique", `${path}[${index}]`);
        } else {
          seen.add(key);
        }
      });
    }
  }

  if (isObject(value)) {
    for (const name of compiled.required) {
      if (!Object.hasOwn(value, name)) {
        issue("required property is missing", propertyPath(path, name));
      }
    }
    for (const [name, item] of Object.entries(value)) {
      const itemPath = propertyPath(path, name);
      if (compiled.propertyNames && valueIssues(compiled.propertyNames, name, itemPath).length > 0) {
        issue("property name must match propertyNames", itemPath);
      }
      const property = compiled.properties.get(name);
      if (property) {
        issues.push(...valueIssues(property, item, itemPath));
        continue;
      }
      if (schema.additionalProperties === false) {
        issue("additional property is not allowed", itemPath);
      } else if (compiled.additional) {
        issues.push(
          ...valueIssues(
            compiled.additional,
            item,
            itemPath,
          ),
        );
      }
    }
  }

  return issues;
}

/** Evaluate one already-normalized JSON value against the portable contract. */
export function validateSchemaValue(
  schema: JsonSchema,
  value: JsonValue,
  path = "value",
): readonly SchemaValueIssue[] {
  const owned = hasValidatedSchema(schema) ? schema : normalizeJson(schema, "schema") as JsonSchema;
  validatePortableSchema(owned);
  return Object.freeze(valueIssues(compile(owned), value, path));
}
