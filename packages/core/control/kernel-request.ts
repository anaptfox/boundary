import { cloneJson, jsonEquals, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { controlError } from "./errors";
import {
  approvalMatchesProposal,
  grantMatchesProposal,
  proposalDigest,
  publicProposal,
  snapshot,
  snapshotApprovalRecords,
} from "./records";
import { normalizeControlPlan } from "./plan";
import {
  actorId,
  beforeAttempt,
  clockNow,
  loadProposal,
  messageOf,
  nextId,
  requireDecision,
  requireTarget,
  resolveCurrentBinding,
  snapshotCreateResult,
  targetOf,
  type ControlRuntime,
} from "./kernel-shared";
import { CONTROL_RECORD_VERSION } from "./types";
import type {
  Approval,
  ControlDecision,
  ControlRequest,
  Grant,
  Proposal,
  ProposalRecord,
} from "./types";

export async function requestControl<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  request: ControlRequest<Actor, Context>,
): Promise<Proposal> {
  const target = requireTarget(request.target, "control.request.target");
  const control = await resolveCurrentBinding(
    runtime.host,
    target,
    "control.request",
  );
  let input: unknown;
  try {
    input = await control.parseInput(request.input);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_REALIZATION",
      `${target.interactionId}.input`,
      messageOf(error, "control input did not match its portable contract"),
      error,
    );
  }
  let rawPlan: unknown;
  try {
    rawPlan = await control.hook.plan({
      input,
      context: request.context,
    });
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      `${target.interactionId}.control.plan`,
      messageOf(error, "control plan failed"),
      error,
    );
  }
  const plan = normalizeControlPlan(
    rawPlan as never,
    `${target.interactionId}.control.plan`,
  );
  let parsedState: unknown;
  let parsedPreview: unknown;
  try {
    parsedState = await control.parseState(plan.state);
    parsedPreview = await control.parsePreview(plan.preview);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      `${target.interactionId}.control.plan`,
      messageOf(error, "control plan did not match its portable contracts"),
      error,
    );
  }
  const id = await nextId(runtime, "proposal");
  const createdAt = clockNow(runtime, "proposal.createdAt");
  const withoutDigest: Omit<ProposalRecord, "proposalDigest"> = Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id,
    ...target,
    requestedBy: actorId(runtime, request.actor),
    input: cloneJson(
      input as JsonValue,
      `${target.interactionId}.input`,
    ),
    subject: plan.subject,
    baseline: plan.baseline,
    baselineSummary: plan.baselineSummary,
    effects: plan.effects,
    state: cloneJson(
      parsedState as JsonValue,
      `${target.interactionId}.control.state`,
    ),
    preview: cloneJson(
      parsedPreview as JsonValue,
      `${target.interactionId}.control.preview`,
    ),
    createdAt,
  });
  const proposal: ProposalRecord = Object.freeze({
    ...withoutDigest,
    proposalDigest: proposalDigest(withoutDigest),
  });

  let decision: ControlDecision;
  try {
    decision = await runtime.policy.request({
      actor: request.actor,
      proposal,
    });
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.request",
      messageOf(error, "request policy failed"),
      error,
    );
  }
  requireDecision(decision, "control.request");
  await resolveCurrentBinding(runtime.host, target, "control.request");

  try {
    const created = snapshotCreateResult(
      await runtime.journal.createProposal(proposal),
      `proposal.${id}.create`,
    );
    if (
      !jsonEquals(
        created.record as unknown as JsonValue,
        proposal as unknown as JsonValue,
      )
    ) {
      throw controlError(
        "CONTROL_JOURNAL_CONFLICT",
        `proposal.${id}`,
        created.kind === "created"
          ? "journal proposal does not match the exact proposal candidate"
          : "proposal digest is already bound to different content",
      );
    }
    await resolveCurrentBinding(runtime.host, target, "control.request");
    return publicProposal(created.record);
  } catch (error) {
    throw beforeAttempt(error, `proposal.${id}`, "proposal write failed");
  }
}

export async function approveControl<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  actor: Actor,
  handle: Proposal | string,
): Promise<Approval> {
  const proposal = await loadProposal(runtime, handle);
  const approvedBy = actorId(runtime, actor);
  let decision: ControlDecision;
  try {
    decision = await runtime.policy.approve({ actor, proposal });
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.approve",
      messageOf(error, "approval policy failed"),
      error,
    );
  }
  requireDecision(decision, "control.approve");
  await resolveCurrentBinding(runtime.host, targetOf(proposal), "control.approve");
  const approval: Approval = Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id: await nextId(runtime, "approval"),
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    ...targetOf(proposal),
    approvedBy,
    approvedAt: clockNow(runtime, "approval.approvedAt"),
    preview: snapshot(proposal.preview, "approval.preview"),
  });
  try {
    const created = snapshotCreateResult(
      await runtime.journal.createApproval(approval),
      `approval.${approval.id}.create`,
    );
    const durableApproval = created.record;
    if (
      !jsonEquals(
        durableApproval as unknown as JsonValue,
        approval as unknown as JsonValue,
      )
    ) {
      throw controlError(
        "CONTROL_JOURNAL_CONFLICT",
        `approval.${approval.id}`,
        "journal approval does not match the exact approval candidate",
      );
    }
    await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.approve",
    );
    return durableApproval;
  } catch (error) {
    throw beforeAttempt(error, `approval.${approval.id}`, "approval write failed");
  }
}

export async function grantControl<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  actor: Actor,
  handle: Proposal | string,
): Promise<Grant> {
  const proposal = await loadProposal(runtime, handle);
  let listedApprovals: unknown;
  try {
    listedApprovals = await runtime.journal.listApprovals(
      proposal.proposalDigest,
    );
  } catch (error) {
    throw beforeAttempt(error, "control.grant", "approval lookup failed");
  }
  let approvals: readonly Approval[];
  try {
    approvals = snapshotApprovalRecords(
      listedApprovals,
      "control.grant.approvals",
    );
  } catch (error) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      "control.grant",
      messageOf(error, "stored approvals are invalid"),
      error,
    );
  }
  if (
    approvals.length === 0 ||
    approvals.some((approval) => !approvalMatchesProposal(approval, proposal))
  ) {
    throw controlError(
      approvals.length === 0
        ? "CONTROL_POLICY_DENIED"
        : "CONTROL_INTEGRITY_MISMATCH",
      "control.grant",
      approvals.length === 0
        ? "at least one exact approval is required"
        : "stored approval does not match the proposal",
    );
  }
  const issuedBy = actorId(runtime, actor);
  let decision: ControlDecision;
  try {
    decision = await runtime.policy.grant({ actor, proposal, approvals });
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.grant",
      messageOf(error, "grant policy failed"),
      error,
    );
  }
  requireDecision(decision, "control.grant");
  await resolveCurrentBinding(runtime.host, targetOf(proposal), "control.grant");
  const issuedAt = clockNow(runtime, "grant.issuedAt");
  if (decision.expiresAt !== undefined && decision.expiresAt <= issuedAt) {
    throw controlError(
      "CONTROL_EXPIRED_GRANT",
      "grant.expiresAt",
      "policy issued an already-expired grant",
    );
  }
  const approvedBy = Object.freeze(
    [...new Set(approvals.map((approval) => approval.approvedBy))].sort(compareUtf8),
  );
  const grant: Grant = Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id: await nextId(runtime, "grant"),
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    ...targetOf(proposal),
    requestedBy: proposal.requestedBy,
    approvedBy,
    subject: snapshot(proposal.subject, "grant.subject"),
    preview: snapshot(proposal.preview, "grant.preview"),
    issuedBy,
    issuedAt,
    ...(decision.expiresAt === undefined
      ? {}
      : { expiresAt: decision.expiresAt }),
  });
  try {
    const created = snapshotCreateResult(
      await runtime.journal.createGrant(grant),
      `grant.${grant.id}.create`,
    );
    const exactCreated = jsonEquals(
      created.record as unknown as JsonValue,
      grant as unknown as JsonValue,
    );
    const validExisting =
      grantMatchesProposal(created.record, proposal) &&
      jsonEquals(
        created.record.approvedBy as unknown as JsonValue,
        approvedBy as unknown as JsonValue,
      ) &&
      created.record.issuedBy === grant.issuedBy &&
      created.record.expiresAt === grant.expiresAt;
    if (
      (created.kind === "created" && !exactCreated) ||
      (created.kind === "existing" && !validExisting)
    ) {
      throw controlError(
        "CONTROL_JOURNAL_CONFLICT",
        `grant.${grant.id}`,
        created.kind === "created"
          ? "journal grant does not match the exact grant candidate"
          : "existing grant does not match exact authority",
      );
    }
    await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.grant",
    );
    return created.record;
  } catch (error) {
    throw beforeAttempt(error, `grant.${grant.id}`, "grant write failed");
  }
}
