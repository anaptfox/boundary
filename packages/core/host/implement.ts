import { snapshotDefinitions } from "./definition-snapshot";
import { failHost } from "./errors";
import type {
  AnyInteractionDefinition,
  ImplementationMap,
  InteractionDefinitions,
  InteractionImplementations,
} from "./types";

type ImplementationMetadata = Readonly<{
  definitions: Readonly<Record<string, AnyInteractionDefinition>>;
  functions: ReadonlyMap<string, (...args: any[]) => unknown>;
}>;

const implementationMetadata = new WeakMap<object, ImplementationMetadata>();

type ExactImplementations<
  Definitions extends InteractionDefinitions,
  Context,
  Candidate extends ImplementationMap<Definitions, Context>,
> = Candidate &
  Record<Exclude<keyof Candidate, keyof Definitions>, never>;

export function implementInteractions<
  const Definitions extends InteractionDefinitions,
  Context = void,
  const Candidate extends ImplementationMap<Definitions, Context> =
    ImplementationMap<Definitions, Context>,
>(
  definitions: Definitions,
  implementations: ExactImplementations<Definitions, Context, Candidate>,
): InteractionImplementations<Definitions, Context> {
  const snapshot = snapshotDefinitions(definitions);
  if (
    implementations === null ||
    typeof implementations !== "object" ||
    Array.isArray(implementations)
  ) {
    return failHost(
      "INVALID_IMPLEMENTATION",
      "implementations",
      "implementations must be a plain closed record",
    );
  }
  const implementationKeys = Reflect.ownKeys(implementations);
  const definitionKeys = Object.keys(snapshot);
  const invalidKey = implementationKeys.find((key) => typeof key !== "string");
  if (invalidKey !== undefined) {
    failHost(
      "INVALID_IMPLEMENTATION",
      "implementations",
      "implementation keys must be strings",
    );
  }
  const actualKeys = implementationKeys as string[];
  const missing = definitionKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !definitionKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    failHost(
      "IMPLEMENTATION_COVERAGE_MISMATCH",
      "implementations",
      `implementation coverage mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  const functions = new Map<string, (...args: any[]) => unknown>();
  for (const key of definitionKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(implementations, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      failHost(
        "INVALID_IMPLEMENTATION",
        `implementations.${key}`,
        "implementations must be enumerable data properties",
      );
    }
    if (typeof descriptor.value !== "function") {
      failHost(
        "INVALID_IMPLEMENTATION",
        `implementations.${key}`,
        "each interaction implementation must be a function",
      );
    }
    functions.set(key, descriptor.value as (...args: any[]) => unknown);
  }
  const value = Object.freeze({}) as InteractionImplementations<
    Definitions,
    Context
  >;
  implementationMetadata.set(value, {
    definitions: snapshot,
    functions,
  });
  return value;
}

export function metadataForImplementations(
  value: unknown,
): ImplementationMetadata {
  if (value === null || typeof value !== "object") {
    return failHost(
      "FOREIGN_IMPLEMENTATIONS",
      "implementations",
      "an authentic InteractionImplementations value is required",
    );
  }
  const metadata = implementationMetadata.get(value);
  if (!metadata) {
    return failHost(
      "FOREIGN_IMPLEMENTATIONS",
      "implementations",
      "an authentic InteractionImplementations value is required",
    );
  }
  return metadata;
}
