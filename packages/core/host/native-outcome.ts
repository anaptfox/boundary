import type { InvocationCertainty, JsonValue } from "@foxworth/boundary/program";
import type {
  AnyInteractionDefinition,
  DefinitionErrors,
  DefinitionOutput,
  ErrorValues,
} from "./types";

/**
 * An opaque result issued by the exact native binding that dispatched it.
 *
 * Native dispatchers receive the factory on `NativeDispatchRequest.outcomes`.
 * Plain outcome-shaped objects are ordinary output values; they cannot change
 * lifecycle certainty or claim a declared error or denial.
 */
export interface NativeDispatchOutcome<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
> {
  readonly [nativeDispatchOutcomeType]?: Definition;
}

/** Factory available only on one installed native dispatch request. */
export interface NativeDispatchOutcomes<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
> {
  returned(value: DefinitionOutput<Definition>): NativeDispatchOutcome<Definition>;
  declared<Code extends keyof DefinitionErrors<Definition> & string>(
    code: Code,
    details: ErrorValues<DefinitionErrors<Definition>>[Code],
  ): NativeDispatchOutcome<Definition>;
  denied(code: string): NativeDispatchOutcome<Definition>;
  notStarted(): NativeDispatchOutcome<Definition>;
  notCompleted(): NativeDispatchOutcome<Definition>;
  unknown(): NativeDispatchOutcome<Definition>;
}

type NativeDispatchOutcomeRecord =
  | Readonly<{ kind: "returned"; value: unknown }>
  | Readonly<{ kind: "declared-error"; code: string; details: JsonValue }>
  | Readonly<{ kind: "denied"; code: string }>
  | Readonly<{
      kind: "fault";
      certainty: Exclude<InvocationCertainty, "completed">;
    }>;

declare const nativeDispatchOutcomeType: unique symbol;

const issuedRecords = new WeakMap<
  object,
  Readonly<{ factory: object; record: NativeDispatchOutcomeRecord }>
>();
const capturedRecords = new WeakMap<object, NativeDispatchOutcomeRecord>();

function issue<Definition extends AnyInteractionDefinition>(
  factory: object,
  record: NativeDispatchOutcomeRecord,
): NativeDispatchOutcome<Definition> {
  const outcome = Object.freeze({});
  issuedRecords.set(outcome, Object.freeze({ factory, record }));
  return outcome as NativeDispatchOutcome<Definition>;
}

export function createNativeDispatchOutcomes<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
>(): NativeDispatchOutcomes<Definition> {
  const outcomes: NativeDispatchOutcomes<Definition> = {
    returned(value: DefinitionOutput<Definition>) {
      return issue<Definition>(outcomes, Object.freeze({ kind: "returned", value }));
    },
    declared<Code extends keyof DefinitionErrors<Definition> & string>(
      code: Code,
      details: ErrorValues<DefinitionErrors<Definition>>[Code],
    ) {
      return issue<Definition>(
        outcomes,
        Object.freeze({ kind: "declared-error", code, details }),
      );
    },
    denied(code: string) {
      return issue<Definition>(outcomes, Object.freeze({ kind: "denied", code }));
    },
    notStarted() {
      return issue<Definition>(
        outcomes,
        Object.freeze({ kind: "fault", certainty: "not-started" }),
      );
    },
    notCompleted() {
      return issue<Definition>(
        outcomes,
        Object.freeze({ kind: "fault", certainty: "not-completed" }),
      );
    },
    unknown() {
      return issue<Definition>(
        outcomes,
        Object.freeze({ kind: "fault", certainty: "unknown" }),
      );
    },
  };
  return Object.freeze(outcomes);
}

export function nativeDispatchOutcomeRecord(
  value: unknown,
): NativeDispatchOutcomeRecord | undefined {
  return value !== null && typeof value === "object"
    ? capturedRecords.get(value)
    : undefined;
}

/**
 * Captures an outcome only when the native dispatcher returned a token issued
 * by this exact request's factory. The captured token is private to the
 * installation boundary; a retained token from another call becomes ordinary
 * output and cannot carry denial or certainty across an invocation.
 */
export function captureNativeDispatchOutcome(
  value: unknown,
  outcomes: object,
): object | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const issued = issuedRecords.get(value);
  if (!issued || issued.factory !== outcomes) return undefined;
  const captured = Object.freeze({});
  capturedRecords.set(captured, issued.record);
  return captured;
}
