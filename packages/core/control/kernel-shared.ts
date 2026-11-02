import { cloneJson, isInteractionId, isSha256Digest, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { ControlError, controlError } from "./errors";
import { publicHandleMatches, requireValidProposal, snapshot } from "./records";
import { validateControlHook } from "./realization";
import type {
  ControlBinding,
  ControlDecision,
  ControlHost,
  ControlOptions,
  ControlTarget,
  CreateRecordResult,
  Proposal,
  ProposalRecord,
} from "./types";

export type ControlRuntime<Actor, Context> = ControlOptions<Actor> & {
  readonly host: ControlHost<Context>;
};

export function snapshotCreateResult<RecordValue>(
  value: CreateRecordResult<RecordValue>,
  path: string,
): CreateRecordResult<RecordValue> {
  const result = snapshot(value, path) as unknown as Record<string, unknown>;
  const keys = Object.keys(result).sort(compareUtf8);
  if (
    keys.length !== 2 ||
    keys[0] !== "kind" ||
    keys[1] !== "record" ||
    (result["kind"] !== "created" && result["kind"] !== "existing")
  ) {
    throw controlError(
      "CONTROL_JOURNAL_CONFLICT",
      path,
      "journal create result must contain exactly kind and record",
    );
  }
  return result as unknown as CreateRecordResult<RecordValue>;
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function beforeAttempt(
  error: unknown,
  path: string,
  fallback: string,
): ControlError {
  return error instanceof ControlError
    ? error
    : controlError("CONTROL_JOURNAL_CONFLICT", path, messageOf(error, fallback), error);
}

export function clockNow<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  path: string,
): number {
  let value: number;
  try {
    value = runtime.clock.now();
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_CLOCK",
      path,
      messageOf(error, "control clock failed"),
      error,
    );
  }
  if (!Number.isFinite(value)) {
    throw controlError(
      "CONTROL_INVALID_CLOCK",
      path,
      "control clock must return a finite timestamp",
    );
  }
  return value;
}

export async function nextId<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  kind: Parameters<ControlRuntime<Actor, Context>["journal"]["nextId"]>[0],
): Promise<string> {
  let value: string;
  try {
    value = await runtime.journal.nextId(kind);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_ID",
      `${kind}.id`,
      messageOf(error, `failed to allocate ${kind} id`),
      error,
    );
  }
  if (!value.trim()) {
    throw controlError(
      "CONTROL_INVALID_ID",
      `${kind}.id`,
      `${kind} id must be non-empty`,
    );
  }
  return value;
}

export function actorId<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  actor: Actor,
): string {
  let value: string;
  try {
    value = runtime.policy.identify(actor);
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.actor",
      messageOf(error, "policy could not identify actor"),
      error,
    );
  }
  if (!value.trim()) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.actor",
      "policy actor identity must be non-empty",
    );
  }
  return value;
}

export function requireDecision(
  decision: ControlDecision,
  path: string,
): asserts decision is Extract<ControlDecision, { readonly allow: true }> {
  if (!decision || typeof decision !== "object" || typeof decision.allow !== "boolean") {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      path,
      "policy must return an explicit allow decision",
    );
  }
  if (!decision.allow) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      path,
      decision.reason || "policy denied control action",
    );
  }
  if (decision.expiresAt !== undefined && !Number.isFinite(decision.expiresAt)) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      path,
      "policy expiration must be a finite timestamp",
    );
  }
}

export function targetOf(proposal: ProposalRecord): ControlTarget {
  return Object.freeze({
    bindingDigest: proposal.bindingDigest,
    projectionDigest: proposal.projectionDigest,
    installationId: proposal.installationId,
    installationDigest: proposal.installationDigest,
    expectedProgramDigest: proposal.expectedProgramDigest,
    actualProgramDigest: proposal.actualProgramDigest,
    programDigest: proposal.programDigest,
    interactionId: proposal.interactionId,
    expectedContractDigest: proposal.expectedContractDigest,
    contractDigest: proposal.contractDigest,
    requestRealizationId: proposal.requestRealizationId,
    executionRealizationId: proposal.executionRealizationId,
    controlRealizationDigest: proposal.controlRealizationDigest,
    controlDigest: proposal.controlDigest,
  });
}

export function recordIdentity(target: ControlTarget): ControlTarget {
  return Object.freeze({ ...requireTarget(target, "control.identity") });
}

function targetMatches(left: ControlTarget, right: ControlTarget): boolean {
  return (
    left.bindingDigest === right.bindingDigest &&
    left.projectionDigest === right.projectionDigest &&
    left.installationId === right.installationId &&
    left.installationDigest === right.installationDigest &&
    left.expectedProgramDigest === right.expectedProgramDigest &&
    left.actualProgramDigest === right.actualProgramDigest &&
    left.programDigest === right.programDigest &&
    left.interactionId === right.interactionId &&
    left.expectedContractDigest === right.expectedContractDigest &&
    left.contractDigest === right.contractDigest &&
    left.requestRealizationId === right.requestRealizationId &&
    left.executionRealizationId === right.executionRealizationId &&
    left.controlRealizationDigest === right.controlRealizationDigest &&
    left.controlDigest === right.controlDigest
  );
}

export function requireTarget(target: ControlTarget, path: string): ControlTarget {
  if (
    !target ||
    typeof target !== "object" ||
    !isSha256Digest(target.bindingDigest) ||
    !isSha256Digest(target.projectionDigest) ||
    typeof target.installationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(target.installationId) ||
    !isSha256Digest(target.installationDigest) ||
    !isSha256Digest(target.expectedProgramDigest) ||
    !isSha256Digest(target.actualProgramDigest) ||
    !isSha256Digest(target.programDigest) ||
    !isInteractionId(target.interactionId) ||
    !isSha256Digest(target.expectedContractDigest) ||
    !isSha256Digest(target.contractDigest) ||
    typeof target.requestRealizationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(target.requestRealizationId) ||
    typeof target.executionRealizationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(target.executionRealizationId) ||
    !isSha256Digest(target.controlRealizationDigest) ||
    !isSha256Digest(target.controlDigest)
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      "control target must contain exact Installation, Program, interaction, realization, and control identity",
    );
  }
  return Object.freeze({ ...target });
}

function requireBindingFunction(
  value: unknown,
  path: string,
): asserts value is (input: unknown) => unknown {
  if (typeof value !== "function") {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      path,
      "control binding must provide portable input, state, preview, and output parsers",
    );
  }
}

async function requireCurrentInstallation<Context>(
  host: ControlHost<Context>,
  expected: ControlTarget,
  path: string,
): Promise<void> {
  try {
    const current = await host.inspect();
    if (
      current.installationId !== expected.installationId ||
      current.installationDigest !== expected.installationDigest ||
      current.programDigest !== expected.programDigest
    ) {
      throw new Error("stored authority targets a different Installation");
    }
  } catch (error) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      path,
      messageOf(error, "current Installation could not be inspected"),
      error,
    );
  }
}

export async function resolveCurrentBinding<Context>(
  host: ControlHost<Context>,
  targetValue: ControlTarget,
  path: string,
): Promise<ControlBinding<Context>> {
  const target = requireTarget(targetValue, `${path}.target`);
  await requireCurrentInstallation(host, target, `${path}.installation`);
  let candidate: ControlBinding<Context>;
  try {
    candidate = await host.resolve(target);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw controlError(
      "CONTROL_NOT_CONFIGURED",
      path,
      messageOf(error, "exact controlled realization could not be resolved"),
      error,
    );
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !candidate.target ||
    !targetMatches(candidate.target, target)
  ) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `${path}.target`,
      "host resolved a different controlled target",
    );
  }
  requireBindingFunction(candidate.parseInput, `${path}.parseInput`);
  requireBindingFunction(candidate.parseState, `${path}.parseState`);
  requireBindingFunction(candidate.parsePreview, `${path}.parsePreview`);
  requireBindingFunction(candidate.parseOutput, `${path}.parseOutput`);
  const hook = validateControlHook<Context>(
    candidate.hook,
    `${target.interactionId}.control`,
  );
  if (hook.realizationDigest !== target.controlRealizationDigest) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `${path}.controlRealizationDigest`,
      "host resolved a different packaged control realization",
    );
  }
  return Object.freeze({
    target,
    hook,
    parseInput: candidate.parseInput,
    parseState: candidate.parseState,
    parsePreview: candidate.parsePreview,
    parseOutput: candidate.parseOutput,
  });
}

export async function loadProposalRecord<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  handle: Proposal | string,
): Promise<ProposalRecord> {
  const id = typeof handle === "string" ? handle : handle.id;
  let stored: ProposalRecord | undefined;
  try {
    stored = await runtime.journal.getProposal(id);
  } catch (error) {
    throw beforeAttempt(error, `proposal.${id}`, "proposal lookup failed");
  }
  if (!stored) {
    throw controlError(
      "CONTROL_UNKNOWN_PROPOSAL",
      `proposal.${id}`,
      `unknown proposal: ${id}`,
    );
  }
  const proposal = await requireValidProposal(stored);
  if (proposal.id !== id) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `proposal.${id}`,
      "journal proposal id does not match its requested key",
    );
  }
  if (typeof handle !== "string" && !publicHandleMatches(handle, proposal)) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `proposal.${id}`,
      "proposal handle does not match its durable record",
    );
  }
  return proposal;
}

export async function loadProposal<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  handle: Proposal | string,
): Promise<ProposalRecord> {
  const proposal = await loadProposalRecord(runtime, handle);
  await resolveCurrentBinding(runtime.host, targetOf(proposal), "proposal");
  return proposal;
}

export async function parsePrivateProposal<Context>(
  binding: ControlBinding<Context>,
  proposal: ProposalRecord,
): Promise<{
  readonly input: unknown;
  readonly state: JsonValue;
  readonly preview: JsonValue;
}> {
  const input = await binding.parseInput(proposal.input);
  const state = await binding.parseState(proposal.state);
  const preview = await binding.parsePreview(proposal.preview);
  return Object.freeze({
    input,
    state: cloneJson(state as JsonValue, `${proposal.interactionId}.control.state`),
    preview: cloneJson(
      preview as JsonValue,
      `${proposal.interactionId}.control.preview`,
    ),
  });
}
