import {
  isInvocationFaultLegal, normalizeJson, validateInvocationObservation, validateSchemaValue,
  type BindingInteractionDescription, type JsonValue, type RawInvocationOutcome,
} from "@foxworth/boundary/program";
import type { MaybePromise } from "./types";

export type InvocationPolicy = Readonly<Omit<RawInvocationOutcome, "certainty" | "result">>;
export interface CoordinatedInvocation<Context> {
  readonly policy: InvocationPolicy;
  readonly interaction: BindingInteractionDescription;
  readonly input: JsonValue;
  readonly context: Context;
}

/** Native host policy: admission precedes this hook, including retained-result disclosure.
 * The zero-argument continuation preserves the exact invocation and dispatches at most once.
 * Hosts own serialization, retained-input identity, storage, and reconciliation; unknown is not retry permission.
 */
export type InvocationCoordinator<Context> = (
  invocation: CoordinatedInvocation<Context>,
  proceed: () => Promise<RawInvocationOutcome>,
) => MaybePromise<RawInvocationOutcome>;

function keys(value: object, required: readonly string[]): void {
  if (Object.keys(value).length !== required.length || required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError("invalid coordinated outcome fields");
  }
}

/** Check a host-retained outcome without accepting native request-owned factory tokens. */
export function checkedCoordinatedOutcome<Context>(
  value: unknown, request: CoordinatedInvocation<Context>,
): RawInvocationOutcome {
  const outcome = normalizeJson(value) as unknown as RawInvocationOutcome;
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) throw new TypeError("invalid coordinated outcome");
  keys(outcome, [...Object.keys(request.policy), "certainty", "result"]);
  for (const key of Object.keys(request.policy) as (keyof InvocationPolicy)[]) {
    if (outcome[key] !== request.policy[key]) throw new TypeError(`coordinated outcome changed ${key}`);
  }
  const { result, ...identity } = outcome;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError("invalid coordinated result");
  validateInvocationObservation({ version: 1, ...identity, resultKind: result.kind, reads: [], changes: [] });
  const { expected, actual } = request.interaction;
  const conforms = (schema: Parameters<typeof validateSchemaValue>[0], data: unknown) =>
    validateSchemaValue(schema, data as JsonValue).length === 0;
  switch (result.kind) {
    case "returned":
      keys(result, ["kind", "value"]);
      if (!conforms(expected.contract.outputSchema, result.value) || !conforms(actual.contract.outputSchema, result.value)) throw new TypeError("invalid retained output");
      break;
    case "declared-error": {
      keys(result, ["kind", "code", "details"]);
      const declared = { code: result.code, details: result.details };
      if (!expected.contract.errorSchema || !actual.contract.errorSchema
        || !conforms(expected.contract.errorSchema, declared) || !conforms(actual.contract.errorSchema, declared)) throw new TypeError("invalid retained declared error");
      break;
    }
    case "proposed":
      keys(result, ["kind", "proposal"]);
      if (!request.interaction.request || !conforms(request.interaction.request.previewSchema, result.proposal)) throw new TypeError("invalid retained proposal");
      break;
    case "denied":
      keys(result, ["kind", "code"]);
      if (typeof result.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(result.code)) throw new TypeError("invalid retained denial");
      break;
    case "fault": {
      keys(result, ["kind", "cause"]);
      if (!isInvocationFaultLegal(outcome.mode, result.cause, outcome.certainty)) throw new TypeError("invalid retained fault certainty");
      break;
    }
  }
  return outcome;
}
