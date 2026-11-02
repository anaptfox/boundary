import type { InteractionMode } from "@foxworth/boundary/program";
import { isInvocationFaultLegal, validateSchemaValue, type JsonObject } from "@foxworth/boundary/program";
import { HandoffError, failHandoff } from "./errors";
import type { HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffResult, HandoffValidationIssue } from "./types";
import { FAULT_CAUSES, exact, outcomeFailure, pinnedInteraction, requireDigest, requireInteractionId, requireMode, requireOpaqueId, requireVersion, snapshot, validatedInvocations, validatedManifests } from "./checks";
import { validateProjectionBindingManifest } from "./manifest";

/** Snapshot and validate only the v1 invocation envelope shape. */
export function validateHandoffInvocation(
  value: unknown,
): HandoffInvocation {
  if (value !== null && typeof value === "object" && validatedInvocations.has(value)) {
    return value as HandoffInvocation;
  }
  const owned = snapshot(value, "invocation", "invocation");
  requireVersion(
    owned !== null && typeof owned === "object" && !Array.isArray(owned)
      ? (owned as JsonObject).version
      : undefined,
    "invocation.version",
  );
  const raw = exact(
    owned,
    "invocation",
    [
      "version",
      "bindingDigest",
      "installationId",
      "interactionId",
      "expectedContractDigest",
      "actualContractDigest",
      "mode",
      "realizationId",
      "input",
    ],
    [],
    "invocation",
  );
  requireVersion(raw.version, "invocation.version");
  requireDigest(raw.bindingDigest, "invocation.bindingDigest", "invocation");
  requireOpaqueId(raw.installationId, "invocation.installationId", "invocation");
  requireInteractionId(raw.interactionId, "invocation.interactionId", "invocation");
  requireDigest(raw.expectedContractDigest, "invocation.expectedContractDigest", "invocation");
  requireDigest(raw.actualContractDigest, "invocation.actualContractDigest", "invocation");
  requireMode(raw.mode, "invocation.mode", "invocation");
  requireOpaqueId(raw.realizationId, "invocation.realizationId", "invocation");
  if (owned !== null && typeof owned === "object") validatedInvocations.add(owned);
  return owned as unknown as HandoffInvocation;
}

function validateResult(
  rawValue: unknown,
  mode: InteractionMode,
  certainty: HandoffOutcome["certainty"],
): HandoffResult {
  const path = "outcome.result";
  const tagged = exact(rawValue, path, ["kind"], [
    "value",
    "code",
    "details",
    "proposal",
    "cause",
    "issues",
  ], "outcome");
  switch (tagged.kind) {
    case "returned": {
      exact(rawValue, path, ["kind", "value"], [], "outcome");
      if (mode !== "direct" || certainty !== "completed") {
        outcomeFailure(path, "returned is valid only for a completed direct invocation");
      }
      return rawValue as HandoffResult;
    }
    case "declared-error": {
      exact(rawValue, path, ["kind", "code", "details"], [], "outcome");
      if (
        mode !== "direct" ||
        certainty !== "completed" ||
        typeof tagged.code !== "string" ||
        !tagged.code.trim()
      ) {
        outcomeFailure(path, "declared-error requires a non-empty code on a completed direct invocation");
      }
      return rawValue as HandoffResult;
    }
    case "proposed": {
      exact(rawValue, path, ["kind", "proposal"], [], "outcome");
      if (mode !== "request" || certainty !== "not-started") {
        outcomeFailure(path, "proposed is valid only for a not-started request invocation");
      }
      return rawValue as HandoffResult;
    }
    case "denied": {
      exact(rawValue, path, ["kind", "code"], [], "outcome");
      if (
        certainty !== "not-started" ||
        typeof tagged.code !== "string" ||
        !tagged.code.trim()
      ) {
        outcomeFailure(path, "denied requires a non-empty code and not-started certainty");
      }
      return rawValue as HandoffResult;
    }
    case "fault": {
      const fault = exact(
        rawValue,
        path,
        ["kind", "cause"],
        ["issues"],
        "outcome",
      );
      if (!FAULT_CAUSES.has(tagged.cause as HandoffFaultCause)) {
        outcomeFailure(path, "fault requires a stable cause");
      }
      const cause = tagged.cause as HandoffFaultCause;
      if (!isInvocationFaultLegal(mode, cause, certainty)) {
        outcomeFailure(
          path,
          `fault cause ${cause} is invalid for ${mode} mode with ${certainty} certainty`,
        );
      }
      if (fault.issues !== undefined) {
        if (tagged.cause !== "invalid-input") {
          outcomeFailure(
            `${path}.issues`,
            "validation issues are valid only for invalid-input faults",
          );
        }
        validateIssues(fault.issues, `${path}.issues`);
      }
      return rawValue as HandoffResult;
    }
    default:
      return outcomeFailure(`${path}.kind`, "unknown Handoff result kind");
  }
}

function validateIssues(
  value: unknown,
  path: string,
): readonly HandoffValidationIssue[] {
  if (!Array.isArray(value) || value.length === 0) {
    outcomeFailure(path, "validation issues must be a non-empty array");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const issuePath = `${path}[${index}]`;
      const issue = exact(
        entry,
        issuePath,
        ["path", "message"],
        [],
        "outcome",
      );
      if (typeof issue.path !== "string" || !issue.path.trim()) {
        outcomeFailure(`${issuePath}.path`, "issue path must be non-empty");
      }
      if (typeof issue.message !== "string" || !issue.message.trim()) {
        outcomeFailure(`${issuePath}.message`, "issue message must be non-empty");
      }
      return Object.freeze({ path: issue.path, message: issue.message });
    }),
  );
}

/** Snapshot and validate an untrusted v1 outcome and its certainty law. */
export function validateHandoffOutcome(value: unknown): HandoffOutcome {
  const owned = snapshot(value, "outcome", "outcome");
  requireVersion(
    owned !== null && typeof owned === "object" && !Array.isArray(owned)
      ? (owned as JsonObject).version
      : undefined,
    "outcome.version",
  );
  const raw = exact(
    owned,
    "outcome",
    [
      "version",
      "bindingDigest",
      "installationId",
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
  );
  requireVersion(raw.version, "outcome.version");
  requireDigest(raw.bindingDigest, "outcome.bindingDigest", "outcome");
  requireOpaqueId(raw.installationId, "outcome.installationId", "outcome");
  requireInteractionId(raw.interactionId, "outcome.interactionId", "outcome");
  requireDigest(raw.expectedContractDigest, "outcome.expectedContractDigest", "outcome");
  requireDigest(raw.actualContractDigest, "outcome.actualContractDigest", "outcome");
  requireMode(raw.mode, "outcome.mode", "outcome");
  requireOpaqueId(raw.realizationId, "outcome.realizationId", "outcome");
  if (
    raw.certainty !== "not-started" &&
    raw.certainty !== "not-completed" &&
    raw.certainty !== "completed" &&
    raw.certainty !== "unknown"
  ) {
    outcomeFailure("outcome.certainty", "certainty is invalid");
  }
  validateResult(raw.result, raw.mode, raw.certainty);
  return owned as unknown as HandoffOutcome;
}

/** Validate a remote outcome against the exact handshake it claims to answer. */
export async function validateHandoffOutcomeAgainstManifest(
  manifestValue: unknown,
  outcomeValue: unknown,
): Promise<HandoffOutcome> {
  const manifest = await validateProjectionBindingManifest(manifestValue);
  const outcome = validateHandoffOutcome(outcomeValue);
  if (outcome.bindingDigest !== manifest.bindingDigest) {
    failHandoff("STALE_BINDING", "outcome.bindingDigest", "outcome targets a different Binding");
  }
  if (outcome.installationId !== manifest.installationId) {
    failHandoff("STALE_INSTALLATION", "outcome.installationId", "outcome targets a different Installation");
  }
  const index = validatedManifests.get(manifest)!;
  const interaction = index.interactions.get(outcome.interactionId)?.get(outcome.mode);
  if (!interaction) {
    failHandoff("INTERACTION_NOT_EXPOSED", "outcome.interactionId", "outcome interaction mode is not exposed by this Binding");
  }
  if (
    interaction.expectedContractDigest !== outcome.expectedContractDigest ||
    interaction.actualContractDigest !== outcome.actualContractDigest
  ) {
    failHandoff("STALE_CONTRACT", "outcome.expectedContractDigest", "outcome contract pins do not match this Binding");
  }
  if (interaction.realizationId !== outcome.realizationId) {
    failHandoff("STALE_REALIZATION", "outcome.realizationId", "outcome realization does not match this Binding");
  }
  const expected = index.expected.get(outcome.interactionId)!;
  const actual = index.actual.get(outcome.interactionId)!;
  if (outcome.result.kind === "returned") {
    if (
      validateSchemaValue(expected.contract.outputSchema, outcome.result.value, "outcome.result.value").length > 0 ||
      validateSchemaValue(actual.contract.outputSchema, outcome.result.value, "outcome.result.value").length > 0
    ) {
      outcomeFailure("outcome.result.value", "returned value does not match both pinned contracts");
    }
  }
  if (outcome.result.kind === "declared-error") {
    const declared = Object.freeze({
      code: outcome.result.code,
      details: outcome.result.details,
    });
    if (
      expected.contract.errorSchema === undefined ||
      actual.contract.errorSchema === undefined ||
      validateSchemaValue(expected.contract.errorSchema, declared, "outcome.result").length > 0 ||
      validateSchemaValue(actual.contract.errorSchema, declared, "outcome.result").length > 0
    ) {
      outcomeFailure("outcome.result", "declared error does not match both pinned contracts");
    }
  }
  if (
    outcome.result.kind === "proposed" &&
    validateSchemaValue(
      interaction.request!.previewSchema,
      outcome.result.proposal,
      "outcome.result.proposal",
    ).length > 0
  ) {
    outcomeFailure("outcome.result.proposal", "proposal does not match the pinned request contract");
  }
  return outcome;
}

/** Check one response against the exact sent invocation and its pinned contracts.
 * Identity correlation does not prove which input computed a returned value.
 */
export async function validateHandoffResponse(
  manifestValue: unknown,
  invocationValue: unknown,
  outcomeValue: unknown,
): Promise<HandoffOutcome> {
  const manifest = await validateProjectionBindingManifest(manifestValue);
  const invocation = validateHandoffInvocation(invocationValue);
  const outcome = await validateHandoffOutcomeAgainstManifest(manifest, outcomeValue);
  for (const key of [
    "bindingDigest", "installationId", "interactionId", "expectedContractDigest",
    "actualContractDigest", "mode", "realizationId",
  ] as const) {
    if (outcome[key] !== invocation[key]) {
      outcomeFailure(`outcome.${key}`, "response does not answer the sent invocation");
    }
  }
  try {
    pinnedInteraction(manifest, invocation);
  } catch (error) {
    // A checked server rejects malformed interaction input before dispatch. That
    // rejection is valid evidence, not an unknown response to a valid attempt.
    if (!(error instanceof HandoffError && error.code === "INVALID_INPUT" &&
      outcome.result.kind === "fault" && outcome.result.cause === "invalid-input")) {
      throw error;
    }
  }
  return outcome;
}
