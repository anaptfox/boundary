import { type JsonSchema } from "./json";
import {
  acceptsValue,
  incompatible,
  schemaType,
  type AcceptsEvery,
  type ContractCompatibility,
  type ExtraProperties,
} from "./schema-compatibility-base";
import { isObject, propertyPath } from "./validation";

/**
 * Object rules of the structural schema matcher (schema-compatibility.ts):
 * named properties, `propertyNames`, and the additional-property domain.
 */

function requiredNames(schema: JsonSchema): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

function propertyMap(schema: JsonSchema): Readonly<Record<string, JsonSchema>> {
  if (!isObject(schema.properties as never)) return {};
  const properties: Record<string, JsonSchema> = {};
  for (const [name, property] of Object.entries(schema.properties as object)) {
    if (isObject(property as never)) properties[name] = property as JsonSchema;
  }
  return properties;
}

function widerTypeIsObject(schema: JsonSchema): boolean {
  return schemaType(schema) === "object";
}

/** Whether `narrower` admits `name` as an additional (unnamed) property. */
function admitsAdditionalName(narrower: JsonSchema, name: string, path: string): boolean {
  if (narrower.additionalProperties === false) return false;
  return !isObject(narrower.propertyNames as never) ||
    acceptsValue(narrower.propertyNames as JsonSchema, name, path);
}

/** The value schema of narrower's additional properties; absent or true is open. */
function additionalValues(schema: JsonSchema): JsonSchema | false {
  if (schema.additionalProperties === false) return false;
  return isObject(schema.additionalProperties as never)
    ? schema.additionalProperties as JsonSchema
    : {};
}

/** Every key the narrower schema admits must satisfy wider propertyNames. */
function acceptsPropertyNames(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
  acceptsEvery: AcceptsEvery,
): ContractCompatibility {
  if (!isObject(wider.propertyNames as never)) return { compatible: true };
  const widerNames = wider.propertyNames as JsonSchema;
  const narrowerNames = isObject(narrower.propertyNames as never)
    ? narrower.propertyNames as JsonSchema
    : undefined;
  for (const name of Object.keys(propertyMap(narrower))) {
    if (narrowerNames && !acceptsValue(narrowerNames, name, path)) continue;
    if (!acceptsValue(widerNames, name, path)) {
      return incompatible("property name is not accepted", propertyPath(path, name));
    }
  }
  if (narrower.additionalProperties === false) return { compatible: true };
  // Object keys are always strings, so an untyped narrower key schema is a
  // string schema; an absent one admits every string.
  const offered: JsonSchema = narrowerNames === undefined
    ? { type: "string" }
    : narrowerNames.type === undefined
      ? { ...narrowerNames, type: "string" }
      : narrowerNames;
  return acceptsEvery(widerNames, offered, `${path}.propertyNames`, extras);
}

/** Narrower's additional-property domain must be accepted by wider's. */
function acceptsAdditionalDomain(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
  acceptsEvery: AcceptsEvery,
): ContractCompatibility {
  const offered = additionalValues(narrower);
  if (offered === false) return { compatible: true };
  const additional = wider.additionalProperties;
  if (additional === false) {
    return incompatible("open additional properties are not accepted", `${path}.additionalProperties`);
  }
  if (!isObject(additional as never)) return { compatible: true };
  return acceptsEvery(additional as JsonSchema, offered, `${path}.additionalProperties`, extras);
}

export function acceptsObject(
  wider: JsonSchema,
  narrower: JsonSchema,
  path: string,
  extras: ExtraProperties,
  acceptsEvery: AcceptsEvery,
): ContractCompatibility {
  const widerProperties = propertyMap(wider);
  const narrowerProperties = propertyMap(narrower);
  const widerRequired = new Set(requiredNames(wider));
  const narrowerRequired = new Set(requiredNames(narrower));

  if (
    widerTypeIsObject(wider) ||
    widerRequired.size > 0 ||
    Object.keys(widerProperties).length > 0 ||
    wider.additionalProperties !== undefined ||
    wider.propertyNames !== undefined
  ) {
    for (const name of widerRequired) {
      if (!narrowerRequired.has(name)) {
        return incompatible("required property may be omitted", propertyPath(path, name));
      }
    }
    for (const [name, widerProperty] of Object.entries(widerProperties)) {
      const narrowerProperty = narrowerProperties[name];
      if (narrowerProperty === undefined) {
        if (widerRequired.has(name)) {
          return incompatible("required property is missing", propertyPath(path, name));
        }
        // An optional wider property the narrower schema may still carry as
        // an additional property must accept those additional values.
        if (!admitsAdditionalName(narrower, name, path)) continue;
        const nested = acceptsEvery(
          widerProperty,
          additionalValues(narrower) || {},
          propertyPath(path, name),
          extras,
        );
        if (!nested.compatible) return nested;
        continue;
      }
      const nested = acceptsEvery(
        widerProperty,
        narrowerProperty,
        propertyPath(path, name),
        extras,
      );
      if (!nested.compatible) return nested;
    }
    const names = acceptsPropertyNames(wider, narrower, path, extras, acceptsEvery);
    if (!names.compatible) return names;
    // Ignoring extras is sound only when the wider side does not read them:
    // a record (`additionalProperties` schema) reads every unnamed entry.
    if (extras === "ignore" && !isObject(wider.additionalProperties as never)) {
      return { compatible: true };
    }
    for (const name of Object.keys(narrowerProperties)) {
      if (widerProperties[name] !== undefined) continue;
      const additional = wider.additionalProperties;
      if (additional === false) {
        return incompatible("additional property is not accepted", propertyPath(path, name));
      }
      if (isObject(additional as never)) {
        const nested = acceptsEvery(
          additional as JsonSchema,
          narrowerProperties[name]!,
          propertyPath(path, name),
          extras,
        );
        if (!nested.compatible) return nested;
      }
    }
    return acceptsAdditionalDomain(wider, narrower, path, extras, acceptsEvery);
  }
  return { compatible: true };
}
