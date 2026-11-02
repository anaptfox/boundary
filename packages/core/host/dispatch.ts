import { checkedCoordinatedOutcome } from "./coordination";
import { observationCorrelation, publishObservation } from "./observation";
import { bindingDescriptions, normalizeJson, validateSchemaValue, type JsonValue } from "@foxworth/boundary/program";
import { definitionForDeclaredError, isAuthenticDeclaredError } from "./definitions";
import { failHost, InteractionFault } from "./errors";
import { nativeDispatchOutcomeRecord } from "./native-outcome";
import type { InteractionMode, BindingInteraction, RawInvocationOutcome, RequestInvocationPolicy, ResolvedBindingInteraction } from "./types";
import { admitted } from "./admission";
import { BindingMetadata, ModeResolution, bindingMetadata, bindingRevoked, resolvedMetadata } from "./binding-state";

function portableInput(
  value: unknown,
  resolution: ModeResolution<any>,
): JsonValue {
  let input: JsonValue;
  try {
    input = normalizeJson(value, `${resolution.actual.contract.id}.input`);
  } catch {
    throw new InteractionFault(
      "invalid-input",
      "not-started",
      "interaction input is not portable JSON",
    );
  }
  const actualIssues = validateSchemaValue(
    resolution.actual.contract.inputSchema,
    input,
    `${resolution.actual.contract.id}.input`,
  );
  const expectedIssues = resolution.sameContract
    ? actualIssues
    : validateSchemaValue(
        resolution.expected.contract.inputSchema,
        input,
        `${resolution.actual.contract.id}.input`,
      );
  if (expectedIssues.length > 0 || actualIssues.length > 0) {
    throw new InteractionFault(
      "invalid-input",
      "not-started",
      "interaction input does not match the bound contract",
    );
  }
  return input;
}

function outcomeBase(
  metadata: BindingMetadata<any>,
  manifest: BindingInteraction,
) {
  return {
    bindingDigest: metadata.manifest.bindingDigest,
    projectionDigest: metadata.manifest.projectionDigest,
    installationId: metadata.installation.installationId,
    installationDigest: metadata.manifest.installationDigest,
    interactionId: manifest.interactionId,
    expectedContractDigest: manifest.expectedContractDigest,
    actualContractDigest: manifest.actualContractDigest,
    mode: manifest.mode,
    realizationId: manifest.realizationId,
  } as const;
}

function requestInvocationPolicy<Context>(
  metadata: BindingMetadata<Context>,
  resolution: ModeResolution<Context>,
): RequestInvocationPolicy {
  return Object.freeze({
    mode: "request",
    bindingDigest: metadata.manifest.bindingDigest,
    projectionDigest: metadata.manifest.projectionDigest,
    installationId: metadata.manifest.installationId,
    installationDigest: metadata.manifest.installationDigest,
    expectedProgramDigest: metadata.manifest.expectedProgramDigest,
    actualProgramDigest: metadata.manifest.actualProgramDigest,
    installationProgramDigest: metadata.installation.manifest.program.programDigest,
    interactionId: resolution.manifest.interactionId,
    expectedContractDigest: resolution.manifest.expectedContractDigest,
    actualContractDigest: resolution.manifest.actualContractDigest,
    realizationId: resolution.manifest.realizationId,
  });
}

function notStartedFault(
  metadata: BindingMetadata<any>,
  manifest: BindingInteraction,
  cause: string,
): RawInvocationOutcome {
  return Object.freeze({
    ...outcomeBase(metadata, manifest),
    certainty: "not-started",
    result: Object.freeze({ kind: "fault", cause }),
  });
}

function modeResolution<Context>(
  metadata: BindingMetadata<Context>,
  binding: object,
  interaction: ResolvedBindingInteraction,
  mode: InteractionMode,
): ModeResolution<Context> | undefined {
  const resolved = resolvedMetadata.get(interaction);
  if (!resolved || resolved.binding !== binding) return undefined;
  return metadata.interactions.get(resolved.interactionId)?.byMode.get(mode);
}

export async function rawInvoke<Context>(
  binding: object,
  interaction: ResolvedBindingInteraction,
  mode: InteractionMode,
  input: unknown,
  context: Context,
): Promise<RawInvocationOutcome> {
  const metadata = bindingMetadata.get(binding) as BindingMetadata<Context> | undefined;
  if (metadata?.observer === undefined) {
    return rawInvokeUnobserved(binding, interaction, mode, input, context);
  }
  const correlation = observationCorrelation(metadata.observer, context);
  const outcome = await rawInvokeUnobserved(binding, interaction, mode, input, context);
  const descriptor = metadata?.interactions.get(outcome.interactionId)?.byMode.get(mode)?.actual.contract;
  await publishObservation(
    metadata.observer, outcome,
    descriptor?.reads ?? [], descriptor?.changes ?? [], correlation,
  );
  return outcome;
}

async function rawInvokeUnobserved<Context>(
  binding: object,
  interaction: ResolvedBindingInteraction,
  mode: InteractionMode,
  rawInput: unknown,
  context: Context,
): Promise<RawInvocationOutcome> {
  const metadata = bindingMetadata.get(binding) as
    | BindingMetadata<Context>
    | undefined;
  if (!metadata) {
    return failHost(
      "INVALID_INVOCATION",
      "binding",
      "an authentic Binding is required",
    );
  }
  const resolution = modeResolution(metadata, binding, interaction, mode);
  if (!resolution) {
    throw new InteractionFault(
      "invalid-invocation",
      "not-started",
      "resolved interaction or mode does not belong to this Binding",
    );
  }
  if (bindingRevoked(metadata)) {
    return notStartedFault(
      metadata,
      resolution.manifest,
      "revoked",
    );
  }
  let input: JsonValue;
  try {
    input = portableInput(rawInput, resolution);
  } catch (error) {
    return notStartedFault(
      metadata,
      resolution.manifest,
      error instanceof InteractionFault ? error.cause : "invalid-input",
    );
  }
  const decision = await admitted(metadata, resolution, input, context);
  if (!decision) {
    return notStartedFault(
      metadata,
      resolution.manifest,
      "admission-failed",
    );
  }
  if (decision.decision === "deny") {
    return Object.freeze({
      ...outcomeBase(metadata, resolution.manifest),
      certainty: "not-started",
      result: Object.freeze({ kind: "denied", code: "CALL_NOT_ADMITTED" }),
    });
  }
  if (bindingRevoked(metadata)) {
    return notStartedFault(
      metadata,
      resolution.manifest,
      "revoked",
    );
  }

  if (metadata.coordinator !== undefined) {
    const request = Object.freeze({
      policy: Object.freeze(outcomeBase(metadata, resolution.manifest)),
      interaction: bindingDescriptions(metadata.manifest).find(entry =>
        entry.interactionId === resolution.manifest.interactionId && entry.mode === mode)!,
      input, context,
    });
    let closed = false;
    let execution: Promise<RawInvocationOutcome> | undefined;
    const proceed = () => {
      if (closed) return Promise.reject(new TypeError("coordination continuation has expired"));
      // Assign before entering native code: a synchronous dispatcher can re-enter proceed.
      execution ??= Promise.resolve().then(() => bindingRevoked(metadata)
        ? notStartedFault(metadata, resolution.manifest, "revoked")
        : dispatchInvocation(metadata, resolution, mode, input, context));
      return execution;
    };
    try {
      const returned = metadata.coordinator(request, proceed);
      // A synchronous retained return must expire before queued microtasks can enter proceed.
      if (!(returned !== null && typeof returned === "object" && "then" in returned)) closed = true;
      const coordinated = await returned;
      closed = true;
      if (execution === undefined && bindingRevoked(metadata)) {
        return notStartedFault(metadata, resolution.manifest, "revoked");
      }
      return checkedCoordinatedOutcome(coordinated, request);
    } catch {
      closed = true;
      return Object.freeze({ ...request.policy, certainty: "unknown", result: Object.freeze({ kind: "fault", cause: "realization-failed" }) });
    }
  }
  return dispatchInvocation(metadata, resolution, mode, input, context);
}

async function dispatchInvocation<Context>(
  metadata: BindingMetadata<Context>, resolution: ModeResolution<Context>,
  mode: InteractionMode, input: JsonValue, context: Context,
): Promise<RawInvocationOutcome> {
  if (mode === "request") {
    try {
      const proposal = normalizeJson(
        await resolution.actual.request!.execute(
          input,
          context,
          requestInvocationPolicy(metadata, resolution),
        ),
        `${resolution.actual.contract.id}.proposal`,
      );
      if (
        validateSchemaValue(
          resolution.actual.request!.previewSchema,
          proposal,
          `${resolution.actual.contract.id}.proposal`,
        ).length > 0
      ) {
        return notStartedFault(
          metadata,
          resolution.manifest,
          "request-failed",
        );
      }
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "not-started",
        result: Object.freeze({ kind: "proposed", proposal }),
      });
    } catch {
      return notStartedFault(
        metadata,
        resolution.manifest,
        "request-failed",
      );
    }
  }

  try {
    const raw = await resolution.actual.direct!.execute(input, context);
    const native = nativeDispatchOutcomeRecord(raw);
    if (native?.kind === "denied") {
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "not-started",
        result: Object.freeze({ kind: "denied", code: native.code }),
      });
    }
    if (native?.kind === "fault") {
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: native.certainty,
        result: Object.freeze({ kind: "fault", cause: "realization-failed" }),
      });
    }
    if (native?.kind === "declared-error") {
      const actualSchema = resolution.actual.errorSchemas[native.code];
      if (
        actualSchema !== undefined &&
        validateSchemaValue(
          actualSchema,
          native.details,
          `${resolution.actual.contract.id}.errors.${native.code}`,
        ).length === 0
      ) {
        return Object.freeze({
          ...outcomeBase(metadata, resolution.manifest),
          certainty: "completed",
          result: Object.freeze({
            kind: "declared-error",
            code: native.code,
            details: native.details,
          }),
        });
      }
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "unknown",
        result: Object.freeze({
          kind: "fault",
          cause: "invalid-realization-outcome",
        }),
      });
    }
    const outputValue = native?.kind === "returned" ? native.value : raw;
    let output: JsonValue;
    try {
      output = normalizeJson(outputValue, `${resolution.actual.contract.id}.output`);
    } catch {
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "unknown",
        result: Object.freeze({
          kind: "fault",
          cause: "invalid-realization-outcome",
        }),
      });
    }
    const actualIssues = validateSchemaValue(
      resolution.actual.contract.outputSchema,
      output,
      `${resolution.actual.contract.id}.output`,
    );
    const expectedIssues = resolution.sameContract
      ? actualIssues
      : validateSchemaValue(
          resolution.expected.contract.outputSchema,
          output,
          `${resolution.actual.contract.id}.output`,
        );
    if (actualIssues.length > 0 || expectedIssues.length > 0) {
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "unknown",
        result: Object.freeze({
          kind: "fault",
          cause: "invalid-realization-outcome",
        }),
      });
    }
    return Object.freeze({
      ...outcomeBase(metadata, resolution.manifest),
      certainty: "completed",
      result: Object.freeze({ kind: "returned", value: output }),
    });
  } catch (error) {
    if (isAuthenticDeclaredError(error)) {
      const definition = definitionForDeclaredError(error);
      const actualSchema = resolution.actual.errorSchemas[error.code];
      if (
        definition === resolution.actual.definition &&
        actualSchema !== undefined &&
        error.interactionId === resolution.manifest.interactionId &&
        validateSchemaValue(
          actualSchema,
          error.details,
          `${error.interactionId}.errors.${error.code}`,
        ).length === 0
      ) {
        return Object.freeze({
          ...outcomeBase(metadata, resolution.manifest),
          certainty: "completed",
          result: Object.freeze({
            kind: "declared-error",
            code: error.code,
            details: error.details,
          }),
        });
      }
      return Object.freeze({
        ...outcomeBase(metadata, resolution.manifest),
        certainty: "unknown",
        result: Object.freeze({
          kind: "fault",
          cause: "invalid-realization-outcome",
        }),
      });
    }
    return Object.freeze({
      ...outcomeBase(metadata, resolution.manifest),
      certainty: "unknown",
      result: Object.freeze({ kind: "fault", cause: "realization-failed" }),
    });
  }
}
