import { z } from "zod";
import { SchemaCompilationError, jsonValue } from "./zod-json";

const PORTABLE_ZOD_CHECKS = new Set([
  "greater_than",
  "less_than",
  "length_equals",
  "max_length",
  "min_length",
  "multiple_of",
  "number_format",
  "string_format",
]);

type ZodInternals = {
  readonly _zod?: {
    readonly def?: Record<string, unknown>;
    readonly bag?: Record<string, unknown>;
  };
};

export function validateZodNode(
  schema: z.ZodType,
  path: string,
  active: WeakSet<object> = new WeakSet(),
): void {
  if (active.has(schema)) {
    throw new SchemaCompilationError(
      "SCHEMA_NOT_PORTABLE",
      path,
      "recursive schemas are not in Boundary's portable schema profile",
    );
  }
  active.add(schema);
  try {
    validateActiveZodNode(schema, path, active);
  } finally {
    active.delete(schema);
  }
}

function validateActiveZodNode(
  schema: z.ZodType,
  path: string,
  active: WeakSet<object>,
): void {
  const internals = (schema as z.ZodType & ZodInternals)._zod;
  const def = internals?.def;
  if (!def) {
    throw new SchemaCompilationError(
      "SCHEMA_UNKNOWN_ZOD_NODE",
      path,
      "schema internals are unavailable",
    );
  }
  // Zod 4.6 installs both generated and externally supplied parser fast paths
  // without changing `def`. Neither marker proves that the parser implements
  // that declaration; compile the original schema before attaching a parser.
  const bag = internals?.bag;
  if (typeof bag?.validator === "function" && typeof bag.fallbackRun === "function") {
    throw new SchemaCompilationError(
      "SCHEMA_RUNTIME_TRANSFORM",
      path,
      "attached Zod parser equivalence is unproven; compile the original declarative schema",
    );
  }
  const metadata = z.globalRegistry.get(schema);
  if (metadata !== undefined) jsonValue(metadata, `${path}.metadata`);

  const type = def.type;
  if (
    type === "default" ||
    type === "transform" ||
    type === "pipe" ||
    type === "catch" ||
    type === "prefault" ||
    type === "readonly"
  ) {
    throw new SchemaCompilationError(
      "SCHEMA_RUNTIME_TRANSFORM",
      path,
      `Zod ${String(type)} semantics are not portable`,
    );
  }
  if (
    type === "any" ||
    type === "unknown" ||
    type === "custom" ||
    type === "date" ||
    type === "bigint" ||
    type === "file" ||
    type === "map" ||
    type === "set" ||
    type === "function" ||
    type === "promise" ||
    type === "symbol" ||
    type === "undefined" ||
    type === "void" ||
    type === "nan" ||
    type === "success"
  ) {
    throw new SchemaCompilationError(
      "SCHEMA_NON_JSON_TYPE",
      path,
      `Zod ${String(type)} is not JSON portable`,
    );
  }
  if (def.coerce === true) {
    throw new SchemaCompilationError(
      "SCHEMA_RUNTIME_TRANSFORM",
      path,
      "Zod coercion is not portable",
    );
  }
  const checks = Array.isArray(def.checks) ? def.checks : [];
  for (const check of checks) {
    const checkDef = (check as unknown as ZodInternals)._zod?.def;
    const checkKind = checkDef?.check;
    if (checkKind === "custom" || checkKind === "overwrite") {
      throw new SchemaCompilationError(
        "SCHEMA_RUNTIME_TRANSFORM",
        path,
        `Zod ${String(checkKind)} semantics are not portable`,
      );
    }
    if (
      typeof checkKind !== "string" ||
      !PORTABLE_ZOD_CHECKS.has(checkKind)
    ) {
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        `Zod ${String(checkKind)} checks are not in Boundary's portable schema profile`,
      );
    }
    if (
      checkDef?.format === "regex" &&
      checkDef.pattern instanceof RegExp &&
      checkDef.pattern.flags !== "u"
    ) {
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        "regular expressions must use exactly the Unicode flag to match JSON Schema pattern semantics",
      );
    }
    if (
      checkDef?.check === "string_format" &&
      checkDef.format === "includes" &&
      checkDef.position !== undefined
    ) {
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        "Zod includes(position) cannot be represented faithfully by JSON Schema pattern",
      );
    }
    if (checkDef?.check === "multiple_of") {
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        "Zod multipleOf uses floating tolerance that JSON Schema does not define",
      );
    }
  }

  const child = (value: unknown, segment: string) => {
    if (value && typeof value === "object" && "_zod" in value) {
      validateZodNode(value as z.ZodType, `${path}.${segment}`, active);
    }
  };
  const children = (value: unknown, segment: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => child(item, `${segment}${index}`));
  };
  switch (type) {
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "null":
    case "never":
    case "enum":
    case "literal":
      break;
    case "array":
      child(def.element, "items");
      break;
    case "object": {
      // A plain z.object strips unknown keys when Zod parses, while its
      // contract rejects them. Strict objects (catchall never) and explicit
      // catchall schemas behave the same in Zod and in the contract.
      if (def.catchall === undefined) {
        throw new SchemaCompilationError(
          "SCHEMA_NOT_PORTABLE",
          path,
          "Zod objects strip unknown keys; use z.strictObject() or .strict() so Zod and the contract agree",
        );
      }
      const shape = def.shape;
      if (shape && typeof shape === "object") {
        for (const [name, value] of Object.entries(shape)) child(value, name);
      }
      child(def.catchall, "catchall");
      break;
    }
    case "union":
      // Exclusive unions (z.xor, z.discriminatedUnion) emit oneOf. With every
      // object strict, Zod and oneOf agree on which branches a value matches.
      children(def.options, "option");
      break;
    case "intersection": {
      // Zod folds two disjoint strict objects into one closed object. Anything
      // else would leave allOf, whose meaning differs from Zod's merge.
      const left = strictObjectShape(def.left);
      const right = strictObjectShape(def.right);
      if (!left || !right || Object.keys(left).some((key) => key in right)) {
        throw new SchemaCompilationError(
          "SCHEMA_NOT_PORTABLE",
          path,
          "Zod intersections are portable only between strict objects with disjoint keys",
        );
      }
      child(def.left, "left");
      child(def.right, "right");
      break;
    }
    case "tuple":
      // Zod emits prefixItems with `items: false` (closed) or the rest schema,
      // plus minItems/maxItems, which together state its arity exactly.
      if (!Array.isArray(def.items) || def.items.length === 0) {
        throw new SchemaCompilationError(
          "SCHEMA_NOT_PORTABLE",
          path,
          "empty Zod tuples are not in Boundary's portable schema profile",
        );
      }
      children(def.items, "item");
      child(def.rest, "rest");
      break;
    case "record": {
      // Only string-keyed records are open maps in both Zod and JSON Schema.
      // Enum and literal keys make Zod records exhaustive, and loose records
      // pass through keys that fail the key schema.
      const keyType = (def.keyType as ZodInternals | undefined)?._zod?.def?.type;
      if (keyType !== "string" || def.mode !== undefined || def.partial !== undefined) {
        throw new SchemaCompilationError(
          "SCHEMA_NOT_PORTABLE",
          path,
          "Zod records are portable only with z.string() keys (string checks allowed); enum, literal, and number keys are not",
        );
      }
      child(def.keyType, "key");
      child(def.valueType, "value");
      break;
    }
    case "optional":
    case "nullable":
    case "nonoptional":
      child(def.innerType, "inner");
      break;
    case "template_literal":
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        "Zod template literals do not preserve Unicode regular-expression semantics",
      );
    case "lazy":
      throw new SchemaCompilationError(
        "SCHEMA_NOT_PORTABLE",
        path,
        "Zod lazy schemas are not in Boundary's portable schema profile",
      );
    default:
      throw new SchemaCompilationError(
        "SCHEMA_UNKNOWN_ZOD_NODE",
        path,
        `Zod ${String(type)} is not in Boundary's portable schema profile`,
      );
  }
}

/** The shape of a strict object (`catchall: never`), or undefined for anything else. */
function strictObjectShape(value: unknown): Record<string, unknown> | undefined {
  const def = (value as ZodInternals | undefined)?._zod?.def;
  if (def?.type !== "object") return undefined;
  const catchall = (def.catchall as ZodInternals | undefined)?._zod?.def;
  if (catchall?.type !== "never") return undefined;
  return def.shape && typeof def.shape === "object" ? def.shape as Record<string, unknown> : undefined;
}
