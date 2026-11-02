import type { InteractionContract, JsonValue } from "@foxworth/boundary/program";
import { failHost } from "../errors";
import type { AnyInteractionDefinition } from "../types";
import { createObservedExecutor } from "./runtime";
import type { ObservedReadOptions } from "./types";

type Options = ObservedReadOptions<AnyInteractionDefinition, unknown, JsonValue, JsonValue, JsonValue, JsonValue>;
const observed = new WeakMap<Function, Readonly<{ definition: AnyInteractionDefinition; options: Options }>>();

export function registerObservedRead(implementation: Function, definition: AnyInteractionDefinition, options: Options) {
  observed.set(implementation, Object.freeze({ definition, options }));
}

/** Private integration seam: one executor/cache per exact installation. */
export function installObservedRead(
  implementation: Function, definition: AnyInteractionDefinition,
  contract: InteractionContract, pins: Readonly<{ installationId: string; realizationId: string }>,
) {
  const metadata = observed.get(implementation);
  if (!metadata) return undefined;
  if (metadata.definition !== definition) failHost("FOREIGN_IMPLEMENTATIONS", "observedRead", "observed definition differs from installed definition");
  if (!pins.realizationId) failHost("REALIZATION_COVERAGE_MISMATCH", "observedRead", "direct realization requires an explicit identity");
  return createObservedExecutor(metadata.options, contract, pins);
}
