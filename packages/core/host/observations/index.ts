import type { JsonValue } from "@foxworth/boundary/program";
import { isInteractionDefinition } from "../definitions";
import { failHost } from "../errors";
import type { AnyInteractionDefinition } from "../types";
import { registerObservedRead } from "./integration";
import type { ObservedReadImplementation, ObservedReadOptions } from "./types";
export type {
  ObservationSource, ObservedSnapshot, ObservationView, ObservationValidation,
  ObservedPoint, PointEvidence, QueryEvidence, ReadObservation,
  ObservedReadOptions, ObservedReadImplementation, ObservedReadDiagnostic,
} from "./types";

/** Create an inert native implementation adapter. Its cache and exact identity
 * are supplied by Installation, never by the caller or a declaration. */
export function observedRead<
  const Definition extends AnyInteractionDefinition, Context,
  Key extends JsonValue, Point extends JsonValue, Query extends JsonValue, Rows extends JsonValue,
>(
  definition: Definition,
  options: ObservedReadOptions<Definition, Context, Key, Point, Query, Rows>,
): ObservedReadImplementation<Definition, Context> {
  if (!isInteractionDefinition(definition)) failHost("FORGED_DEFINITION", "observedRead", "an authentic definition is required");
  if (definition.changes.length !== 0) failHost("INVALID_IMPLEMENTATION", "observedRead", "observed reads cannot realize changing interactions");
  if (options === null || typeof options !== "object" ||
    typeof options.scope !== "function" || typeof options.authorize !== "function" ||
    typeof options.evaluate !== "function" || typeof options.snapshots?.withSnapshot !== "function" ||
    (options.diagnostic !== undefined && typeof options.diagnostic !== "function")) {
    failHost("INVALID_IMPLEMENTATION", "observedRead", "snapshot, scope, authorization and evaluation functions are required");
  }
  const reuse = options.reuse ?? "off";
  const maxEntries = options.maxEntries ?? 128;
  if ((reuse !== "off" && reuse !== "validated") || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    failHost("INVALID_IMPLEMENTATION", "observedRead", "invalid reuse policy or retention bound");
  }
  const snapshots = Object.freeze({ withSnapshot: options.snapshots.withSnapshot.bind(options.snapshots) });
  const owned = Object.freeze({ snapshots, scope: options.scope.bind(options),
    authorize: options.authorize.bind(options), evaluate: options.evaluate.bind(options),
    ...(options.diagnostic ? { diagnostic: options.diagnostic.bind(options) } : {}), reuse, maxEntries });
  const implementation = Object.freeze(() => { throw new Error("observedRead implementations must be installed before execution"); });
  registerObservedRead(implementation, definition, owned as never);
  return implementation as ObservedReadImplementation<Definition, Context>;
}
