import { type JsonSchema } from "./json";
import {
  acceptsBound,
  acceptsValue,
  incompatible,
  schemaType,
  type ContractCompatibility,
  type ExtraProperties,
} from "./schema-compatibility-base";
import { acceptsObject } from "./schema-compatibility-objects";
import { jsonEquals } from "./snapshot";
import { isObject } from "./validation";

export {
  incompatible,
  type ContractCompatibility,
  type ExtraProperties,
} from "./schema-compatibility-base";

/**
 * Structural schema matcher backing `contractCompatibility` (compatibility.ts).
 * Split out for file-size hygiene; the modules form one feature.
 */
function isOpenSchema(schema: JsonSchema): boolean {
  return Object.keys(schema).length === 0;
}

function typeSubtype(narrower: string, wider: string): boolean {
  return narrower === wider || (narrower === "integer" && wider === "number");
}

export function acceptsEvery(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
): ContractCompatibility {
  if (jsonEquals(wider, narrower)) return { compatible: true };
  if (isOpenSchema(wider)) return { compatible: true };
  if (isOpenSchema(narrower)) {
    return incompatible("open schema is not accepted by a constrained schema", path);
  }

  const widerType = schemaType(wider);
  const narrowerType = schemaType(narrower);
  if (widerType !== undefined && narrowerType !== undefined) {
    if (!typeSubtype(narrowerType, widerType)) {
      return incompatible(`type ${narrowerType} is not assignable to ${widerType}`, path);
    }
  } else if (widerType !== undefined && narrowerType === undefined) {
    return incompatible("untyped schema is not assignable to a typed schema", path);
  }

  if (wider.const !== undefined) {
    if (narrower.const !== undefined) {
      if (!jsonEquals(wider.const, narrower.const)) {
        return incompatible("const values differ", path);
      }
    } else if (Array.isArray(narrower.enum)) {
      if (!narrower.enum.every((value) => jsonEquals(value, wider.const!))) {
        return incompatible("enum is not covered by const", path);
      }
    } else {
      return incompatible("schema is not restricted to the expected const", path);
    }
  } else if (narrower.const !== undefined && !acceptsValue(wider, narrower.const, path)) {
    return incompatible("const value is not accepted", path);
  }

  if (Array.isArray(wider.enum)) {
    const allowed = wider.enum;
    const candidates = Array.isArray(narrower.enum)
      ? narrower.enum
      : narrower.const !== undefined
        ? [narrower.const]
        : undefined;
    if (candidates === undefined) {
      return incompatible("open values are not covered by enum", path);
    }
    if (!candidates.every((value) => allowed.some((item) => jsonEquals(item, value)))) {
      return incompatible("enum values are not covered", path);
    }
  } else if (Array.isArray(narrower.enum)) {
    if (!narrower.enum.every((value) => acceptsValue(wider, value, path))) {
      return incompatible("enum value is not accepted", path);
    }
  }

  const numeric = acceptsNumeric(wider, narrower, path);
  if (!numeric.compatible) return numeric;
  const textual = acceptsTextual(wider, narrower, path);
  if (!textual.compatible) return textual;
  const arrays = acceptsArray(wider, narrower, path, extras);
  if (!arrays.compatible) return arrays;
  const objects = acceptsObject(wider, narrower, path, extras, acceptsEvery);
  if (!objects.compatible) return objects;
  return acceptsCombinators(wider, narrower, path, extras);
}

function acceptsNumeric(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
): ContractCompatibility {
  const checks: ContractCompatibility[] = [
    acceptsBound(wider.minimum, narrower.minimum, path, "minimum", (w, n) => n >= w),
    acceptsBound(wider.maximum, narrower.maximum, path, "maximum", (w, n) => n <= w),
    acceptsBound(
      wider.exclusiveMinimum,
      narrower.exclusiveMinimum,
      path,
      "exclusiveMinimum",
      (w, n) => n >= w,
    ),
    acceptsBound(
      wider.exclusiveMaximum,
      narrower.exclusiveMaximum,
      path,
      "exclusiveMaximum",
      (w, n) => n <= w,
    ),
  ];
  return checks.find((result) => !result.compatible) ?? { compatible: true };
}

function acceptsTextual(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
): ContractCompatibility {
  const length = [
    acceptsBound(wider.minLength, narrower.minLength, path, "minLength", (w, n) => n >= w),
    acceptsBound(wider.maxLength, narrower.maxLength, path, "maxLength", (w, n) => n <= w),
  ].find((result) => !result.compatible);
  if (length) return length;
  if (typeof wider.pattern === "string") {
    if (narrower.pattern !== wider.pattern) {
      return incompatible("pattern is not compatible", `${path}.pattern`);
    }
  }
  return { compatible: true };
}

/** A position's schema: a schema, forbidden (`items: false`), or unconstrained. */
type Slot = JsonSchema | false | undefined;

function itemSlot(schema: JsonSchema, index: number): Slot {
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  if (index < prefix.length) {
    const positional = prefix[index];
    return isObject(positional as never) ? positional as JsonSchema : {};
  }
  if (schema.items === false) return false;
  return isObject(schema.items as never) ? schema.items as JsonSchema : undefined;
}

/** The largest array length a schema admits, from maxItems and a closed tuple. */
function effectiveMaxItems(schema: JsonSchema): number | undefined {
  const closed = schema.items === false
    ? (Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0)
    : undefined;
  const declared = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
  if (closed === undefined) return declared;
  return declared === undefined ? closed : Math.min(closed, declared);
}

function acceptsSlot(
  wider: Slot,
  narrower: Slot,
  path: string,
  extras: ExtraProperties,
): ContractCompatibility {
  if (narrower === false || wider === undefined) return { compatible: true };
  if (wider === false) return incompatible("array item is not accepted", path);
  if (narrower === undefined) {
    return incompatible("array items are not constrained enough", path);
  }
  return acceptsEvery(wider, narrower, path, extras);
}

/**
 * Positional subsumption: every position the narrower schema can fill must be
 * accepted by the wider schema's prefixItems entry or items tail there.
 */
function acceptsItems(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
): ContractCompatibility {
  const limit = effectiveMaxItems(narrower);
  const prefixLength = (schema: JsonSchema) =>
    Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
  const positions = Math.max(prefixLength(wider), prefixLength(narrower));
  for (let index = 0; index < positions; index += 1) {
    if (limit !== undefined && index >= limit) return { compatible: true };
    const narrow = itemSlot(narrower, index);
    if (narrow === false) return { compatible: true };
    const itemPath = index < prefixLength(wider)
      ? `${path}.prefixItems[${index}]`
      : `${path}.items`;
    const nested = acceptsSlot(itemSlot(wider, index), narrow, itemPath, extras);
    if (!nested.compatible) return nested;
  }
  if (limit !== undefined && positions >= limit) return { compatible: true };
  return acceptsSlot(
    itemSlot(wider, positions),
    itemSlot(narrower, positions),
    `${path}.items`,
    extras,
  );
}

function acceptsArray(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
): ContractCompatibility {
  const counts = [
    acceptsBound(wider.minItems, narrower.minItems, path, "minItems", (w, n) => n >= w),
    acceptsBound(wider.maxItems, effectiveMaxItems(narrower), path, "maxItems", (w, n) => n <= w),
  ].find((result) => !result.compatible);
  if (counts) return counts;
  if (wider.uniqueItems === true && narrower.uniqueItems !== true) {
    return incompatible("uniqueItems is required", `${path}.uniqueItems`);
  }
  return acceptsItems(wider, narrower, path, extras);
}

function acceptsCombinators(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
): ContractCompatibility {
  if (Array.isArray(narrower.anyOf)) {
    for (const [index, alternative] of narrower.anyOf.entries()) {
      if (!isObject(alternative as never)) continue;
      const nested = acceptsEvery(wider, alternative as JsonSchema, `${path}.anyOf[${index}]`, extras);
      if (!nested.compatible) return nested;
    }
  }
  if (Array.isArray(narrower.oneOf)) {
    for (const [index, alternative] of narrower.oneOf.entries()) {
      if (!isObject(alternative as never)) continue;
      const nested = acceptsEvery(wider, alternative as JsonSchema, `${path}.oneOf[${index}]`, extras);
      if (!nested.compatible) return nested;
    }
  }
  if (Array.isArray(narrower.allOf) && !Array.isArray(wider.allOf)) {
    for (const [index, alternative] of narrower.allOf.entries()) {
      if (!isObject(alternative as never)) continue;
      const nested = acceptsEvery(wider, alternative as JsonSchema, `${path}.allOf[${index}]`, extras);
      if (!nested.compatible) return nested;
    }
  }
  // Distribution is sufficient for wider anyOf: every offered value needs at
  // least one covering branch. It does not prove the exclusivity of oneOf.
  const narrowerIsUnion = Array.isArray(narrower.anyOf) || Array.isArray(narrower.oneOf);
  if (Array.isArray(wider.anyOf) && !narrowerIsUnion) {
    const match = wider.anyOf.some(
      (alternative) =>
        isObject(alternative as never) &&
        acceptsEvery(alternative as JsonSchema, narrower, path, extras).compatible,
    );
    if (!match) return incompatible("schema is not covered by anyOf", `${path}.anyOf`);
  }
  if (Array.isArray(wider.oneOf)) {
    // A branch that does not cover the whole offered schema may still accept
    // some of its values. Exclude every such arm by declared type, conservatively
    // rejecting unproved overlap. Exact-schema equality returns before this path.
    const offeredType = schemaType(narrower);
    let matches = 0;
    for (const alternative of wider.oneOf) {
      if (!isObject(alternative as never)) {
        return incompatible("oneOf exclusivity is not proven", `${path}.oneOf`);
      }
      const branch = alternative as JsonSchema;
      if (acceptsEvery(branch, narrower, path, extras).compatible) {
        matches += 1;
        continue;
      }
      const branchType = schemaType(branch);
      if (offeredType === undefined || branchType === undefined ||
        typeSubtype(offeredType, branchType) || typeSubtype(branchType, offeredType)) {
        return incompatible("oneOf exclusivity is not proven", `${path}.oneOf`);
      }
    }
    if (matches !== 1) return incompatible("schema is not covered by oneOf", `${path}.oneOf`);
  }
  if (Array.isArray(wider.allOf)) {
    for (const [index, alternative] of wider.allOf.entries()) {
      if (!isObject(alternative as never)) continue;
      const nested = acceptsEvery(alternative as JsonSchema, narrower, `${path}.allOf[${index}]`, extras);
      if (!nested.compatible) return nested;
    }
  }
  if (isObject(wider.not as never) || isObject(narrower.not as never)) {
    if (!jsonEquals(wider.not as never, narrower.not as never)) {
      return incompatible("not schemas are not compatible", `${path}.not`);
    }
  }
  return { compatible: true };
}
