import {
  normalizeJson,
  validateInvocationObservation,
  type InvocationObservation,
  type JsonValue,
  type RawInvocationOutcome,
} from "@foxworth/boundary/program";
import type { MaybePromise } from "./types";

/** Host-held observer; publication is awaited and failures cannot change execution truth. */
export interface InvocationObserver<Context> {
  publish(event: InvocationObservation): MaybePromise<void>;
  correlate?(context: Context): JsonValue;
}

export function snapshotObserver<Context>(
  observer: InvocationObserver<Context> | undefined,
): InvocationObserver<Context> | undefined {
  if (observer === undefined) return undefined;
  const { publish, correlate } = observer;
  if (
    typeof publish !== "function" ||
    (correlate !== undefined && typeof correlate !== "function")
  ) {
    throw new TypeError("invalid invocation observer");
  }
  return Object.freeze({
    publish: publish.bind(observer),
    ...(correlate === undefined ? {} : { correlate: correlate.bind(observer) }),
  });
}

export function observationCorrelation<Context>(
  observer: InvocationObserver<Context> | undefined,
  context: Context,
): JsonValue | undefined {
  try {
    return observer?.correlate === undefined
      ? undefined
      : normalizeJson(observer.correlate(context));
  } catch {
    return undefined;
  }
}

export async function publishObservation<Context>(
  observer: InvocationObserver<Context> | undefined,
  outcome: RawInvocationOutcome,
  reads: readonly string[],
  changes: readonly string[],
  correlation: JsonValue | undefined,
): Promise<void> {
  if (observer === undefined) return;
  const { result, ...identity } = outcome;
  try {
    await observer.publish(validateInvocationObservation({
      version: 1,
      ...identity,
      resultKind: result.kind,
      reads,
      changes,
      ...(correlation === undefined ? {} : { correlation }),
    }));
  } catch {
    // The host owns delivery/replay. Publication is not execution or verification.
  }
}
