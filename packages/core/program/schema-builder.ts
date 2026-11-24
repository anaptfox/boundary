import { portableSchema, type PortableSchema, type PortableSchemaValue } from "./validation";
import type { JsonValue } from "./json";

type Primitive = string | number | boolean | null;
type Options = Readonly<Record<string, JsonValue>>;
type Schema<T extends JsonValue = JsonValue> = PortableSchema<T>;
type OptionalSchema<T extends JsonValue = JsonValue> = Readonly<{ schema: Schema<T>; optional: true }>;
type AnySchema = Schema<JsonValue>;
type PropertySchema = AnySchema | OptionalSchema;
type ValueOf<S> = S extends OptionalSchema<infer T> ? T : S extends Schema<infer T> ? T : never;
type RequiredKeys<P> = { [K in keyof P]-?: P[K] extends OptionalSchema ? never : K }[keyof P];
type OptionalKeys<P> = Exclude<keyof P, RequiredKeys<P>>;
type ObjectValue<P> = { readonly [K in RequiredKeys<P>]: ValueOf<P[K]> } & { readonly [K in OptionalKeys<P>]?: ValueOf<P[K]> };
export type InferSchema<S> = PortableSchemaValue<Extract<S, PortableSchema>>;

function make<T extends JsonValue>(definition: Record<string, unknown>): Schema<T> {
  return portableSchema<T>(definition as never);
}
function withOptions(base: Record<string, unknown>, opts?: Options): Record<string, unknown> {
  return opts ? { ...base, ...opts } : base;
}
function jsonLiteral(value: Primitive): JsonValue { return value; }

function string(opts?: { minLength?: number; maxLength?: number; pattern?: string; format?: string; description?: string }) {
  const { format, description, ...portable } = opts ?? {};
  if (format !== undefined || description !== undefined) throw new TypeError("format and description are outside Boundary's portable schema profile");
  return make<string>(withOptions({ type: "string" }, portable));
}
function number(opts?: { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number; description?: string }) {
  const { multipleOf, description, ...portable } = opts ?? {};
  if (multipleOf !== undefined || description !== undefined) throw new TypeError("multipleOf and description are outside Boundary's portable schema profile");
  return make<number>(withOptions({ type: "number" }, portable));
}
function integer(opts?: { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number; description?: string }) {
  const { multipleOf, description, ...portable } = opts ?? {};
  if (multipleOf !== undefined || description !== undefined) throw new TypeError("multipleOf and description are outside Boundary's portable schema profile");
  return make<number>(withOptions({ type: "integer" }, portable));
}
function boolean() { return make<boolean>({ type: "boolean" }); }
function nil() { return make<null>({ type: "null" }); }
function literal<const T extends Primitive>(value: T) { return make<T>({ const: jsonLiteral(value) }); }
function enumeration<const T extends readonly [Primitive, ...Primitive[]]>(values: T) { return make<T[number]>({ enum: [...values] }); }
function array<S extends AnySchema>(item: S, opts?: { minItems?: number; maxItems?: number; uniqueItems?: boolean; description?: string }) {
  const { description, ...portable } = opts ?? {};
  if (description !== undefined) throw new TypeError("description is outside Boundary's portable schema profile");
  return make<readonly PortableSchemaValue<S>[]>(withOptions({ type: "array", items: item }, portable));
}
function tuple<const T extends readonly AnySchema[]>(items: T, opts?: { description?: string }) {
  if (opts?.description !== undefined) throw new TypeError("description is outside Boundary's portable schema profile");
  return make<readonly JsonValue[]>({ type: "array", prefixItems: [...items], items: false }) as Schema<{ readonly [K in keyof T]: PortableSchemaValue<T[K]> }>;
}
function optional<S extends AnySchema>(schema: S): OptionalSchema<PortableSchemaValue<S>> { return Object.freeze({ schema, optional: true }); }
function object<const P extends Readonly<Record<string, PropertySchema>>>(properties: P, opts?: { description?: string }) {
  if (opts?.description !== undefined) throw new TypeError("description is outside Boundary's portable schema profile");
  const entries = Object.entries(properties);
  const props = Object.fromEntries(entries.map(([key, value]) => [key, "optional" in value ? value.schema : value]));
  const required = entries.filter(([, value]) => !("optional" in value)).map(([key]) => key);
  return make<ObjectValue<P>>({ type: "object", properties: props, ...(required.length ? { required } : {}), additionalProperties: false });
}
function nullable<S extends AnySchema>(schema: S) { return make<PortableSchemaValue<S> | null>({ anyOf: [schema, { type: "null" }] }); }
function record<S extends AnySchema>(valueSchema: S) { return make<Readonly<Record<string, PortableSchemaValue<S>>>>({ type: "object", additionalProperties: valueSchema }); }
function union<const S extends readonly [AnySchema, ...AnySchema[]]>(schemas: S) { return make<PortableSchemaValue<S[number]>>({ anyOf: [...schemas] }); }
function discriminatedUnion(key: string, variants: readonly [AnySchema, ...AnySchema[]]) {
  for (const variant of variants) {
    const props = variant.properties;
    const marker = props && typeof props === "object" ? (props as Record<string, unknown>)[key] : undefined;
    if (variant.type !== "object" || variant.additionalProperties !== false || !Array.isArray(variant.required) || !variant.required.includes(key) || !marker || typeof marker !== "object" || !("const" in marker)) throw new TypeError(`variant must be a strict object with required literal ${key}`);
  }
  return make<PortableSchemaValue<(typeof variants)[number]>>({ oneOf: [...variants] });
}
function json() { return make<JsonValue>({}); }
function describe<S extends AnySchema>(schema: S, description: string): S {
  if (description) throw new TypeError("description is outside Boundary's portable schema profile");
  return portableSchema<PortableSchemaValue<S>>(schema) as S;
}

export const b = Object.freeze({ string, number, integer, boolean, null: nil, literal, enum: enumeration, array, tuple, object, optional, nullable, record, union, discriminatedUnion, json, describe });
