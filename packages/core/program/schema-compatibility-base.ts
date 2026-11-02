import { type JsonSchema } from "./json";
import { validateSchemaValue } from "./schema-value";

/** Leaf rules shared by the structural schema matcher's modules. */
export type ContractCompatibility =
  | { compatible: true }
  | { compatible: false; reason: string; path: string };

export type ExtraProperties = "reject" | "ignore";

export function incompatible(reason: string, path: string): ContractCompatibility {
  return { compatible: false, reason, path };
}

/** The matcher's recursion, passed to rule modules to keep imports acyclic. */
export type AcceptsEvery = (
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
) => ContractCompatibility;

export function schemaType(schema: JsonSchema): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

export function acceptsValue(schema: JsonSchema, value: unknown, path: string): boolean {
  try {
    return validateSchemaValue(schema, value as never, path).length === 0;
  } catch {
    return false;
  }
}

export function acceptsBound(
  wider: unknown,
  narrower: unknown,
  path: string,
  keyword: string,
  compare: (wide: number, narrow: number) => boolean,
): ContractCompatibility {
  if (typeof wider !== "number") return { compatible: true };
  if (typeof narrower !== "number") {
    return incompatible(`${keyword} is not constrained enough`, `${path}.${keyword}`);
  }
  return compare(wider, narrower)
    ? { compatible: true }
    : incompatible(`${keyword} is not compatible`, `${path}.${keyword}`);
}
