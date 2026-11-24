import type {
  AnyInteractionDefinition,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InteractionHandle,
  InteractionMode,
  ProjectedInteractionHandle,
} from "@foxworth/boundary";
import { createHandoffInvocation } from "../execute";
import {
  validateHandoffOutcome,
  validateHandoffOutcomeAgainstManifest,
} from "../messages";
import type {
  CheckedHandoff,
  HandoffFaultCause,
  HandoffInvocation,
  HandoffOutcome,
  HandoffValidationIssue,
} from "../types";
import type { JsonValue } from "@foxworth/boundary/program";
import { AdapterError } from "./errors";
import {
  compileBindingResolution,
  interactionKey,
  type AnyProjectedInteractionHandle,
  type BindingResolution,
  type ResolvedBindingInteraction,
} from "./resolution";

type DefinitionOf<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle<infer Definition>,
  any
> ? Definition : AnyInteractionDefinition;

export type InteractionInput<Handle extends AnyProjectedInteractionHandle> =
  DefinitionInput<DefinitionOf<Handle>>;
export type InteractionOutput<Handle extends AnyProjectedInteractionHandle> =
  DefinitionOutput<DefinitionOf<Handle>>;
export type InteractionHasInput<Handle extends AnyProjectedInteractionHandle> =
  DefinitionArity<DefinitionOf<Handle>> extends 0 ? false : true;

export type SerializedInvocation<Input extends JsonValue = JsonValue> =
  HandoffInvocation<Input>;
export type RemoteCallResult = HandoffOutcome;
export type ExposedInteraction = ResolvedBindingInteraction;
export type Exposure = BindingResolution;

export async function compileExposure(
  handoff: CheckedHandoff<any>,
  selected: readonly Readonly<{
    handle: AnyProjectedInteractionHandle;
    mode: InteractionMode;
  }>[],
): Promise<Exposure> {
  return compileBindingResolution(handoff, selected);
}

export async function compileHandoffExposure(
  handoff: CheckedHandoff<any>,
): Promise<Exposure> {
  const manifest = handoff.manifest;
  const expected = new Map(
    manifest.expectedProgram.interactions.map((descriptor) => [descriptor.contract.id, descriptor]),
  );
  const modesById = new Map<string, InteractionMode[]>();
  for (const interaction of manifest.interactions) {
    const modes = modesById.get(interaction.interactionId) ?? [];
    modes.push(interaction.mode);
    modesById.set(interaction.interactionId, modes);
  }
  const selected = manifest.interactions.map((interaction) => {
    const descriptor = expected.get(interaction.interactionId)!;
    return Object.freeze({
      handle: Object.freeze({
        interactionId: interaction.interactionId,
        contractDigest: descriptor.contractDigest,
        inputArity: interaction.inputArity,
        modes: Object.freeze(modesById.get(interaction.interactionId)!),
      }) as AnyProjectedInteractionHandle,
      mode: interaction.mode,
    });
  });
  return compileBindingResolution(handoff, selected);
}

function outcomeFor(
  exposure: Exposure,
  exposed: ExposedInteraction,
  certainty: HandoffOutcome["certainty"],
  result: HandoffOutcome["result"],
): HandoffOutcome {
  return validateHandoffOutcome({
    version: 1,
    bindingDigest: exposure.manifest.bindingDigest,
    installationId: exposure.manifest.installationId,
    interactionId: exposed.binding.interactionId,
    expectedContractDigest: exposed.binding.expectedContractDigest,
    actualContractDigest: exposed.binding.actualContractDigest,
    mode: exposed.binding.mode,
    realizationId: exposed.binding.realizationId,
    certainty,
    result,
  });
}

/** Preserve exact Binding pins while sanitizing a failure outside Handoff. */
export function sanitizedInternalResult(
  exposure: Exposure,
  exposed: ExposedInteraction,
): HandoffOutcome {
  return outcomeFor(exposure, exposed, "unknown", {
    kind: "fault",
    cause: "realization-failed",
  });
}

export function faultResult(
  exposure: Exposure,
  exposed: ExposedInteraction,
  cause: HandoffFaultCause,
  issues?: readonly HandoffValidationIssue[],
): HandoffOutcome {
  return outcomeFor(exposure, exposed, "not-started", {
    kind: "fault",
    cause,
    ...(issues === undefined ? {} : { issues }),
  });
}

export async function executeExposedInteraction<Context>(args: Readonly<{
  exposure: Exposure;
  context: Context;
  handle: AnyProjectedInteractionHandle;
  mode: InteractionMode;
  input: unknown;
}>): Promise<HandoffOutcome> {
  const prepared = await prepareExposedInteraction(args);
  return invokePreparedInteraction(args.exposure, prepared.invocation, args.context);
}

/** Validate and serialize locally, before the consequential dispatch boundary. */
export async function prepareExposedInteraction(args: Readonly<{
  exposure: Exposure;
  handle: AnyProjectedInteractionHandle;
  mode: InteractionMode;
  input: unknown;
}>): Promise<Readonly<{
  exposed: ExposedInteraction;
  invocation: HandoffInvocation;
}>> {
  const exposed = args.exposure.interactions.get(interactionKey(args.handle.interactionId, args.mode));
  if (!exposed) {
    throw new AdapterError(
      "INTERACTION_NOT_EXPOSED",
      args.handle.interactionId,
      `${args.handle.interactionId} ${args.mode} was not selected for this adapter`,
    );
  }
  const invocation = await createHandoffInvocation(
    args.exposure.manifest,
    exposed.binding.interactionId,
    exposed.binding.mode,
    args.input as JsonValue,
  );
  return Object.freeze({ exposed, invocation });
}

/** The only adapter step that crosses into host dispatch. */
export function invokePreparedInteraction<Context>(
  exposure: Exposure,
  invocation: HandoffInvocation,
  context: Context,
): Promise<HandoffOutcome> {
  return exposure.handoff.invoke(invocation, context);
}

export async function executeSerializedInvocation<Context>(args: Readonly<{
  handoff: CheckedHandoff<Context>;
  context: Context;
  invocation: HandoffInvocation;
}>): Promise<HandoffOutcome> {
  const outcome = await args.handoff.invoke(args.invocation, args.context);
  return validateHandoffOutcomeAgainstManifest(args.handoff.manifest, outcome);
}

export function statusForRemoteResult(result: HandoffOutcome): number {
  if (result.result.kind === "returned") return 200;
  if (result.result.kind === "proposed") return 202;
  if (result.result.kind === "declared-error") return 422;
  if (result.result.kind === "denied") return 403;
  if (result.result.cause === "invalid-input" || result.result.cause === "invalid-invocation") {
    return 400;
  }
  if (result.result.cause === "revoked") return 409;
  return 500;
}

export type {
  AnyProjectedInteractionHandle,
  CheckedHandoff,
  HandoffInvocation,
  HandoffOutcome,
};
