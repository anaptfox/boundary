import type { InteractionMode, BindingManifest, RawInvocationOutcome, RawInvocationResult } from "@foxworth/boundary/program";
import { type JsonValue } from "@foxworth/boundary/program";
import { HandoffError, failHandoff } from "./errors";
import type { CheckedHandoff, HandoffExecutable, HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffResult } from "./types";
import { FAULT_CAUSES, exact, outcomeFailure, pinnedInteraction, snapshot, validatedManifests } from "./checks";
import { validateBindingManifest } from "./manifest";
import { validateHandoffInvocation, validateHandoffOutcome, validateHandoffOutcomeAgainstManifest } from "./messages";

function hasImmutableManifest(
  binding: HandoffExecutable,
  manifest: BindingManifest,
): boolean {
  try {
    const property = Object.getOwnPropertyDescriptor(binding, "manifest");
    if (
      !property || !("value" in property) || property.value !== manifest ||
      property.writable || property.configurable
    ) {
      return false;
    }
    const seen = new WeakSet<object>();
    const pending: unknown[] = [manifest];
    while (pending.length > 0) {
      const value = pending.pop();
      if (
        value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        continue;
      }
      if (typeof value !== "object") return false;
      if (seen.has(value)) continue;
      if (!Object.isFrozen(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      if (
        prototype !== null && prototype !== Object.prototype &&
        prototype !== Array.prototype
      ) {
        return false;
      }
      seen.add(value);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) return false;
        pending.push(descriptor.value);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function invalidInputOutcome(
  manifest: BindingManifest,
  invocation: HandoffInvocation,
  error: HandoffError,
): HandoffOutcome {
  const issues = error.issues ?? Object.freeze([
    Object.freeze({ path: error.path, message: "input is invalid" }),
  ]);
  return validateHandoffOutcome({
    version: 1,
    bindingDigest: manifest.bindingDigest,
    installationId: invocation.installationId,
    interactionId: invocation.interactionId,
    expectedContractDigest: invocation.expectedContractDigest,
    actualContractDigest: invocation.actualContractDigest,
    mode: invocation.mode,
    realizationId: invocation.realizationId,
    certainty: "not-started",
    result: { kind: "fault", cause: "invalid-input", issues },
  });
}

function faultOutcome(
  manifest: BindingManifest,
  invocation: HandoffInvocation,
  certainty: HandoffOutcome["certainty"],
  cause: HandoffFaultCause,
): HandoffOutcome {
  return validateHandoffOutcome({
    version: 1,
    bindingDigest: manifest.bindingDigest,
    installationId: invocation.installationId,
    interactionId: invocation.interactionId,
    expectedContractDigest: invocation.expectedContractDigest,
    actualContractDigest: invocation.actualContractDigest,
    mode: invocation.mode,
    realizationId: invocation.realizationId,
    certainty,
    result: { kind: "fault", cause },
  });
}

function rawResult(result: RawInvocationResult): HandoffResult {
  if (result.kind !== "fault") return result;
  return Object.freeze({
    kind: "fault",
    cause: FAULT_CAUSES.has(result.cause as HandoffFaultCause)
      ? result.cause as HandoffFaultCause
      : "realization-failed",
  });
}

async function outcomeFromRaw(
  manifest: BindingManifest,
  invocation: HandoffInvocation,
  rawValue: RawInvocationOutcome,
): Promise<HandoffOutcome> {
  const owned = snapshot(rawValue, "hostOutcome", "outcome");
  const raw = exact(
    owned,
    "hostOutcome",
    [
      "bindingDigest",
      "projectionDigest",
      "installationId",
      "installationDigest",
      "interactionId",
      "expectedContractDigest",
      "actualContractDigest",
      "mode",
      "realizationId",
      "certainty",
      "result",
    ],
    [],
    "outcome",
  ) as unknown as RawInvocationOutcome;
  const pinsMatch =
    raw.bindingDigest === manifest.bindingDigest &&
    raw.projectionDigest === manifest.projectionDigest &&
    raw.installationId === invocation.installationId &&
    raw.installationDigest === manifest.installationDigest &&
    raw.interactionId === invocation.interactionId &&
    raw.expectedContractDigest === invocation.expectedContractDigest &&
    raw.actualContractDigest === invocation.actualContractDigest &&
    raw.mode === invocation.mode &&
    raw.realizationId === invocation.realizationId;
  if (!pinsMatch) {
    return outcomeFailure("outcome", "host outcome does not echo the invocation identity pins");
  }
  const outcome = validateHandoffOutcome({
    version: 1,
    bindingDigest: manifest.bindingDigest,
    installationId: raw.installationId,
    interactionId: raw.interactionId,
    expectedContractDigest: raw.expectedContractDigest,
    actualContractDigest: raw.actualContractDigest,
    mode: raw.mode,
    realizationId: raw.realizationId,
    certainty: raw.certainty,
    result: rawResult(raw.result),
  });
  return validateHandoffOutcomeAgainstManifest(manifest, outcome);
}

/** Execute exactly once: no retry, rebind, replay, or replacement following. */
export async function executeHandoff<Context>(
  binding: HandoffExecutable,
  invocationValue: unknown,
  context: Context,
): Promise<HandoffOutcome> {
  const invocation = validateHandoffInvocation(invocationValue);
  const manifest = await validateBindingManifest(binding.manifest);
  return executeWithManifest(binding, manifest, invocation, context);
}

async function executeWithManifest<Context>(
  binding: HandoffExecutable,
  manifest: BindingManifest,
  invocation: HandoffInvocation,
  context: Context,
): Promise<HandoffOutcome> {
  try {
    pinnedInteraction(manifest, invocation);
  } catch (error) {
    if (error instanceof HandoffError && error.code === "INVALID_INPUT") {
      return invalidInputOutcome(manifest, invocation, error);
    }
    throw error;
  }
  const interaction = binding.resolve(invocation.interactionId);
  if (!interaction) {
    failHandoff("INTERACTION_NOT_EXPOSED", "invocation.interactionId", "live Binding no longer resolves this interaction");
  }
  let raw: RawInvocationOutcome;
  try {
    raw = await binding.invoke(
      {
        interaction,
        mode: invocation.mode,
        input: invocation.input,
      },
      context,
    );
  } catch {
    return faultOutcome(manifest, invocation, "unknown", "realization-failed");
  }
  try {
    return await outcomeFromRaw(manifest, invocation, raw);
  } catch {
    return invocation.mode === "request"
      ? faultOutcome(manifest, invocation, "unknown", "realization-failed")
      : faultOutcome(
          manifest,
          invocation,
          "unknown",
          "invalid-realization-outcome",
        );
  }
}

/** Create an exact portable envelope for one validated Binding mode. */
export async function createHandoffInvocation(
  manifestValue: unknown,
  interactionId: string,
  mode: InteractionMode,
  input: JsonValue,
): Promise<HandoffInvocation> {
  const manifest = await validateBindingManifest(manifestValue);
  const interaction = validatedManifests.get(manifest)!.interactions.get(interactionId)?.get(mode);
  if (!interaction) {
    failHandoff("MODE_NOT_EXPOSED", "interaction", "Binding does not expose the requested interaction mode");
  }
  return validateHandoffInvocation({
    version: 1,
    bindingDigest: manifest.bindingDigest,
    installationId: manifest.installationId,
    interactionId: interaction.interactionId,
    expectedContractDigest: interaction.expectedContractDigest,
    actualContractDigest: interaction.actualContractDigest,
    mode: interaction.mode,
    realizationId: interaction.realizationId,
    input,
  });
}

/** Bind the checked seam while keeping context invocation-scoped. */
export async function createCheckedHandoff<Context>(
  binding: HandoffExecutable,
): Promise<CheckedHandoff<Context>> {
  const source = binding.manifest;
  // Prove source stability before validation yields. Mutable or accessor-backed
  // seams still validate their current manifest on every invocation.
  const immutable = hasImmutableManifest(binding, source);
  const manifest = await validateBindingManifest(source);
  return Object.freeze({
    manifest,
    async invoke(invocation: HandoffInvocation, context: Context) {
      return immutable
        ? executeWithManifest(binding, manifest, validateHandoffInvocation(invocation), context)
        : executeHandoff(binding, invocation, context);
    },
  });
}
