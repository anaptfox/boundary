import {
  portableSchema,
  type PortableSchema,
  type PortableSchemaValue,
} from "./validation";
import type { JsonValue } from "./json";

type Primitive = string | number | boolean | null;
type Schema<T extends JsonValue = JsonValue> = PortableSchema<T>;
type AnySchema = Schema<any>;

const OPTIONAL_SCHEMA = Symbol("boundary.optionalSchema");

export type OptionalPortableSchema<T extends JsonValue = JsonValue> = Readonly<{
  readonly [OPTIONAL_SCHEMA]: true;
  readonly schema: Schema<T>;
}>;

type PropertySchema = AnySchema | OptionalPortableSchema<any>;
type PropertyValue<S> =
  S extends OptionalPortableSchema<infer T>
    ? T
    : S extends Schema<infer T>
      ? T
      : never;
type RequiredKeys<P> = {
  [K in keyof P]-?: P[K] extends OptionalPortableSchema<any> ? never : K;
}[keyof P];
type OptionalKeys<P> = Exclude<keyof P, RequiredKeys<P>>;
type Expand<T> = { [K in keyof T]: T[K] } & {};
type ObjectValue<P> = Expand<
  { readonly [K in RequiredKeys<P>]: PropertyValue<P[K]> } & {
    readonly [K in OptionalKeys<P>]?: PropertyValue<P[K]>;
  }
>;
type TupleValue<T extends readonly AnySchema[]> = {
  readonly [K in keyof T]: T[K] extends Schema<infer V> ? V : never;
};

/** Infers the TypeScript JSON value type of a schema constructed with `b.*`. */
export type InferSchema<S> =
  S extends Schema<infer T>
    ? T
    : S extends OptionalPortableSchema<infer T>
      ? T | undefined
      : never;

export type StringSchemaOptions = Readonly<{
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}>;

export type NumberSchemaOptions = Readonly<{
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}>;

export type ArraySchemaOptions = Readonly<{
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}>;

function isOptionalSchema(
  value: PropertySchema,
): value is OptionalPortableSchema<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    OPTIONAL_SCHEMA in value &&
    value[OPTIONAL_SCHEMA] === true
  );
}

function make<T extends JsonValue>(
  definition: Record<string, unknown>,
): PortableSchema<T> {
  return portableSchema<T>(definition as never);
}

function pickDefined(
  opts: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!opts) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function string(opts?: StringSchemaOptions): PortableSchema<string> {
  return make<string>({ type: "string", ...pickDefined(opts) });
}

function number(opts?: NumberSchemaOptions): PortableSchema<number> {
  return make<number>({ type: "number", ...pickDefined(opts) });
}

function integer(opts?: NumberSchemaOptions): PortableSchema<number> {
  return make<number>({ type: "integer", ...pickDefined(opts) });
}

function boolean(): PortableSchema<boolean> {
  return make<boolean>({ type: "boolean" });
}

function nil(): PortableSchema<null> {
  return make<null>({ type: "null" });
}

function literal<const T extends Primitive>(value: T): PortableSchema<T> {
  return make<T>({ const: value });
}

function enumeration<const T extends readonly [Primitive, ...Primitive[]]>(
  values: T,
): PortableSchema<T[number]> {
  return make<T[number]>({ enum: [...values] });
}

function array<S extends AnySchema>(
  item: S,
  opts?: ArraySchemaOptions,
): PortableSchema<readonly PortableSchemaValue<S>[]> {
  return make<readonly PortableSchemaValue<S>[]>({
    type: "array",
    items: item,
    ...pickDefined(opts),
  });
}

function tuple<const T extends readonly AnySchema[]>(
  items: T,
): PortableSchema<TupleValue<T>> {
  return make<TupleValue<T>>({
    type: "array",
    prefixItems: [...items],
    items: false,
  });
}

function optional<S extends AnySchema>(
  schema: S,
): OptionalPortableSchema<PortableSchemaValue<S>> {
  return Object.freeze({
    [OPTIONAL_SCHEMA]: true as const,
    schema,
  });
}

function object<const P extends Readonly<Record<string, PropertySchema>>>(
  properties: P,
): PortableSchema<ObjectValue<P>> {
  const entries = Object.entries(properties);
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of entries) {
    if (isOptionalSchema(value)) {
      props[key] = value.schema;
    } else {
      props[key] = value;
      required.push(key);
    }
  }
  return make<ObjectValue<P>>({
    type: "object",
    properties: props,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  });
}

function nullable<S extends AnySchema>(
  schema: S,
): PortableSchema<PortableSchemaValue<S> | null> {
  return make<PortableSchemaValue<S> | null>({
    anyOf: [schema, { type: "null" }],
  });
}

function record<S extends AnySchema>(
  valueSchema: S,
): PortableSchema<Readonly<Record<string, PortableSchemaValue<S>>>> {
  return make<Readonly<Record<string, PortableSchemaValue<S>>>>({
    type: "object",
    additionalProperties: valueSchema,
  });
}

function union<const S extends readonly [AnySchema, ...AnySchema[]]>(
  schemas: S,
): PortableSchema<PortableSchemaValue<S[number]>> {
  return make<PortableSchemaValue<S[number]>>({ anyOf: [...schemas] });
}

function discriminatedUnion<
  const Key extends string,
  const S extends readonly [AnySchema, ...AnySchema[]],
>(
  key: Key,
  variants: S,
): PortableSchema<PortableSchemaValue<S[number]>> {
  const seen = new Set<string>();
  for (const variant of variants) {
    const props = variant.properties;
    const marker =
      props && typeof props === "object"
        ? (props as Record<string, unknown>)[key]
        : undefined;
    if (
      variant.type !== "object" ||
      variant.additionalProperties !== false ||
      !Array.isArray(variant.required) ||
      !variant.required.includes(key) ||
      !marker ||
      typeof marker !== "object" ||
      !("const" in marker)
    ) {
      throw new TypeError(
        `discriminatedUnion variant must be a strict object with required literal property "${key}"`,
      );
    }
    const tag = JSON.stringify((marker as { const: unknown }).const);
    if (seen.has(tag)) {
      throw new TypeError(
        `discriminatedUnion duplicate discriminator value ${tag} for "${key}"`,
      );
    }
    seen.add(tag);
  }
  return make<PortableSchemaValue<S[number]>>({ oneOf: [...variants] });
}

function json(): PortableSchema<JsonValue> {
  return make<JsonValue>({});
}

/**
 * Zero-dependency, strictly portable JSON Schema builder for Boundary contracts.
 *
 * Every schema emitted by `b.*` conforms to Boundary's portable JSON Schema
 * profile by construction (strict objects with `additionalProperties: false`,
 * no unportable transforms or keywords).
 */
export const b = Object.freeze({
  string,
  number,
  integer,
  boolean,
  null: nil,
  literal,
  enum: enumeration,
  array,
  tuple,
  object,
  optional,
  nullable,
  record,
  union,
  discriminatedUnion,
  json,
});
