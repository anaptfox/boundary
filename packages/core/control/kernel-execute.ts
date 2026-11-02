import { cloneJson, jsonEquals, type JsonValue } from "@foxworth/boundary/program";
import { controlError } from "./errors";
import { attemptMatches, publicProposal } from "./records";
import {
  clockNow,
  messageOf,
  nextId,
  requireDecision,
  resolveCurrentBinding,
  snapshotCreateResult,
  targetOf,
  type ControlRuntime,
} from "./kernel-shared";
import {
  bindPrivateProposal,
  containFailure,
  createAttemptSession,
  findExistingAttempt,
  findExistingReceipt,
  leaseDuration,
  loadAuthority,
  notApplied,
  publishReceipt,
  runVerification,
  uncertain,
} from "./kernel-effect";
import { CONTROL_RECORD_VERSION } from "./types";
import type {
  AttemptRecord,
  ControlDecision,
  EffectResult,
  Grant,
  Verification,
} from "./types";

export async function executeControl<Actor, Context, Output = unknown>(
  runtime: ControlRuntime<Actor, Context>,
  grantHandle: Grant | string,
  actor: Actor,
  context: Context,
): Promise<EffectResult<Output>> {
  const authority = await loadAuthority(runtime, grantHandle);
  const { proposal, grant } = authority;
  let decision: ControlDecision;
  try {
    decision = await runtime.policy.execute({ actor, proposal, grant });
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.execute",
      messageOf(error, "execution policy failed"),
      error,
    );
  }
  requireDecision(decision, "control.execute");
  const existingAttempt = await findExistingAttempt(runtime, proposal);
  if (existingAttempt) {
    if (!attemptMatches(existingAttempt, proposal, grant)) {
      throw controlError(
        "CONTROL_INTEGRITY_MISMATCH",
        `attempt.${existingAttempt.id}`,
        "existing attempt does not match exact authority",
      );
    }
    if (existingAttempt.execution === "completed") {
      return publishReceipt<Actor, Context, Output>(
        runtime,
        proposal,
        grant,
        existingAttempt,
      );
    }
    if (existingAttempt.execution === "not-applied") {
      return notApplied(existingAttempt.message ?? "effect was not applied");
    }
    return uncertain(existingAttempt);
  }

  const existingReceipt = await findExistingReceipt(runtime, proposal);
  if (existingReceipt) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `receipt.${existingReceipt.id}`,
      "receipt exists without its exact attempt",
    );
  }

  const { binding, input, state } = await bindPrivateProposal(
    runtime,
    proposal,
    "control.execute",
  );

  const start = clockNow(runtime, "control.execute.startedAt");
  if (grant.expiresAt !== undefined && start >= grant.expiresAt) {
    throw controlError(
      "CONTROL_EXPIRED_GRANT",
      `grant.${grant.id}.expiresAt`,
      "grant expired before execution began",
    );
  }

  try {
    await runtime.policy.preflight({ proposal, grant });
  } catch (error) {
    throw controlError(
      "CONTROL_PREFLIGHT_FAILED",
      "control.execute.preflight",
      messageOf(error, "preflight failed"),
      error,
    );
  }
  await resolveCurrentBinding(runtime.host, targetOf(proposal), "control.execute");
  const attemptAt = clockNow(runtime, "attempt.createdAt");
  if (grant.expiresAt !== undefined && attemptAt >= grant.expiresAt) {
    throw controlError(
      "CONTROL_EXPIRED_GRANT",
      `grant.${grant.id}.expiresAt`,
      "grant expired before the attempt boundary",
    );
  }
  if (!runtime.executor.owner.trim()) {
    throw controlError(
      "CONTROL_INVALID_LEASE",
      "control.executor.owner",
      "executor owner must be non-empty",
    );
  }
  const candidate: AttemptRecord = Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id: await nextId(runtime, "attempt"),
    recordRevision: 1,
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    grantId: grant.id,
    ...targetOf(proposal),
    execution: "started",
    verification: "pending",
    lease: Object.freeze({
      owner: runtime.executor.owner,
      expiresAt: attemptAt + leaseDuration(runtime),
      fence: 1,
    }),
    createdAt: attemptAt,
    updatedAt: attemptAt,
  });
  let attempt: AttemptRecord;
  try {
    const claimed = snapshotCreateResult(
      await runtime.journal.createAttempt(candidate),
      `attempt.${candidate.id}.create`,
    );
    attempt = claimed.record;
    if (claimed.kind === "created") {
      if (
        !jsonEquals(
          attempt as unknown as JsonValue,
          candidate as unknown as JsonValue,
        )
      ) {
        return uncertain(candidate);
      }
    } else if (!attemptMatches(attempt, proposal, grant)) {
      return uncertain(candidate);
    }
    if (claimed.kind === "existing") {
      if (attempt.execution === "completed") {
        return publishReceipt<Actor, Context, Output>(
          runtime,
          proposal,
          grant,
          attempt,
        );
      }
      if (attempt.execution === "not-applied") {
        return notApplied(attempt.message ?? "effect was not applied");
      }
      return uncertain(attempt);
    }
  } catch {
    // Atomic create may have committed before the connection failed.
    return uncertain(candidate);
  }

  try {
    await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.execute",
    );
  } catch {
    return uncertain(attempt);
  }

  const session = createAttemptSession(runtime, attempt);
  let applyBoundaryAt: number;
  try {
    applyBoundaryAt = clockNow(runtime, "control.execute.applyBoundaryAt");
  } catch (error) {
    return containFailure(
      runtime,
      session,
      messageOf(error, "lease state is uncertain before apply"),
    );
  }
  if (applyBoundaryAt >= session.lease.expiresAt) {
    return containFailure(
      runtime,
      session,
      "lease expired before apply began",
    );
  }
  const hookContext = Object.freeze({
    input,
    state,
    proposal: publicProposal(proposal),
    lease: session.lease,
    context,
  });
  let output: unknown;
  try {
    output = await binding.hook.apply(hookContext);
    output = await binding.parseOutput(output);
    output = cloneJson(output as JsonValue, `${proposal.interactionId}.output`);
    const now = clockNow(runtime, "attempt.updatedAt");
    if (
      !(await session.transition({
        execution: "uncertain",
        verification: "pending",
        output: output as JsonValue,
        message: "effect applied; verification pending",
        updatedAt: now,
      }))
    ) {
      return uncertain(session.current());
    }
  } catch (error) {
    return containFailure(
      runtime,
      session,
      messageOf(error, "effect outcome is uncertain"),
    );
  }

  let checked: Verification;
  try {
    checked = await runVerification(
      runtime,
      session,
      proposal,
      binding,
      input,
      state,
      output,
      context,
    );
  } catch (error) {
    return containFailure(
      runtime,
      session,
      messageOf(error, "verification outcome is uncertain"),
      "failed",
    );
  }
  if (!checked.ok) {
    try {
      const now = clockNow(runtime, "attempt.updatedAt");
      await session.transition({
        execution: "uncertain",
        verification: "failed",
        ...(checked.evidence === undefined ? {} : { evidence: checked.evidence }),
        message: checked.message,
        updatedAt: now,
      });
    } catch {
      // Preserve uncertainty if the verifier record cannot be written.
    }
    return uncertain(session.current());
  }
  try {
    const now = clockNow(runtime, "attempt.updatedAt");
    if (
      !(await session.transition({
        execution: "completed",
        verification: "verified",
        ...(checked.evidence === undefined ? {} : { evidence: checked.evidence }),
        message: "verified",
        updatedAt: now,
      }))
    ) {
      return uncertain(session.current());
    }
  } catch {
    return uncertain(session.current());
  }
  return publishReceipt<Actor, Context, Output>(
    runtime,
    proposal,
    grant,
    session.current(),
  );
}
