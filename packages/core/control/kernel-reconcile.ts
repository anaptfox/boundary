import { cloneJson, type JsonValue } from "@foxworth/boundary/program";
import { ControlError, controlError } from "./errors";
import { publicProposal, snapshotAttemptRecord } from "./records";
import {
  clockNow,
  messageOf,
  requireDecision,
  resolveCurrentBinding,
  targetOf,
  type ControlRuntime,
} from "./kernel-shared";
import {
  bindPrivateProposal,
  containFailure,
  createAttemptSession,
  leaseDuration,
  loadAttemptAuthority,
  loadAttemptRecord,
  notApplied,
  publishReceipt,
  runVerification,
  uncertain,
} from "./kernel-effect";
import type {
  UntypedAttemptRef,
  AttemptRecord,
  ControlBinding,
  ControlDecision,
  EffectResult,
  Grant,
  ProposalRecord,
} from "./types";

export async function reconcileControl<Actor, Context, Output = unknown>(
  runtime: ControlRuntime<Actor, Context>,
  handle: UntypedAttemptRef | string,
  actor: Actor,
  context: Context,
): Promise<EffectResult<Output>> {
  let attempt = await loadAttemptRecord(runtime, handle);
  let recovery: {
    readonly proposal: ProposalRecord;
    readonly grant: Grant;
  };
  try {
    recovery = await loadAttemptAuthority(runtime, attempt);
  } catch (error) {
    if (
      error instanceof ControlError &&
      error.code === "CONTROL_JOURNAL_CONFLICT"
    ) {
      return uncertain(attempt);
    }
    throw error;
  }
  const { proposal, grant } = recovery;
  let decision: ControlDecision;
  try {
    decision = await runtime.policy.reconcile({
      actor,
      proposal,
      grant,
      attempt,
    });
  } catch (error) {
    throw controlError(
      "CONTROL_POLICY_DENIED",
      "control.reconcile",
      messageOf(error, "reconciliation policy failed"),
      error,
    );
  }
  requireDecision(decision, "control.reconcile");
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
  let binding: ControlBinding<Context>;
  let input: unknown;
  let state: JsonValue;
  try {
    ({ binding, input, state } = await bindPrivateProposal(
      runtime,
      proposal,
      "control.reconcile",
    ));
  } catch {
    return uncertain(attempt);
  }
  try {
    await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.reconcile",
    );
  } catch {
    return uncertain(attempt);
  }
  let now: number;
  let leaseExpiresAt: number;
  try {
    now = clockNow(runtime, "control.reconcile.startedAt");
    if (attempt.lease.expiresAt > now) return uncertain(attempt);
    leaseExpiresAt = now + leaseDuration(runtime);
  } catch {
    return uncertain(attempt);
  }
  const claimed: AttemptRecord = Object.freeze({
    ...attempt,
    recordRevision: attempt.recordRevision + 1,
    execution: "uncertain",
    lease: Object.freeze({
      owner: runtime.executor.owner,
      expiresAt: leaseExpiresAt,
      fence: attempt.lease.fence + 1,
    }),
    message: "expired attempt claimed for reconciliation",
    updatedAt: now,
  });
  try {
    if (
      !(await runtime.journal.compareAndSwapAttempt(
        claimed,
        attempt.recordRevision,
      ))
    ) {
      const loaded = await runtime.journal.getAttempt(attempt.id);
      const concurrent =
        loaded === undefined ? undefined : snapshotAttemptRecord(loaded);
      if (concurrent !== undefined && concurrent.id !== attempt.id) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          `attempt.${attempt.id}`,
          "journal attempt id does not match its requested key",
        );
      }
      return uncertain(concurrent ?? attempt);
    }
    attempt = claimed;
  } catch {
    return uncertain(attempt);
  }
  try {
    binding = await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.reconcile",
    );
  } catch {
    return uncertain(attempt);
  }
  const session = createAttemptSession(runtime, attempt);

  if (attempt.output !== undefined) {
    try {
      const output = await binding.parseOutput(attempt.output);
      const checked = await runVerification(
        runtime,
        session,
        proposal,
        binding,
        input,
        state,
        output,
        context,
      );
      if (checked.ok) {
        const updatedAt = clockNow(runtime, "attempt.updatedAt");
        if (
          await session.transition({
            execution: "completed",
            verification: "verified",
            ...(checked.evidence === undefined
              ? {}
              : { evidence: checked.evidence }),
            message: "verified during reconciliation",
            updatedAt,
          })
        ) {
          return publishReceipt<Actor, Context, Output>(
            runtime,
            proposal,
            grant,
            session.current(),
          );
        }
        return uncertain(session.current());
      }
    } catch {
      // Fall through to reality reconciliation; apply is never called here.
    }
  }

  let result: unknown;
  try {
    result = await binding.hook.reconcile({
      input,
      state,
      proposal: publicProposal(proposal),
      lease: session.lease,
      context,
    });
  } catch (error) {
    return containFailure(
      runtime,
      session,
      messageOf(error, "reconciliation outcome is uncertain"),
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return containFailure(
      runtime,
      session,
      "reconciliation returned an invalid result",
    );
  }
  const classified = result as Record<string, unknown>;
  if (classified["status"] === "not-applied") {
    if (
      typeof classified["reason"] !== "string" ||
      !classified["reason"].trim()
    ) {
      return containFailure(
        runtime,
        session,
        "reconciliation returned not-applied without a reason",
      );
    }
    const reason = classified["reason"];
    try {
      const updatedAt = clockNow(runtime, "attempt.updatedAt");
      await session.transition({
        execution: "not-applied",
        verification: "pending",
        message: reason,
        updatedAt,
      });
    } catch {
      return uncertain(session.current());
    }
    return session.current().execution === "not-applied"
      ? notApplied(reason)
      : uncertain(session.current());
  }
  if (classified["status"] === "uncertain") {
    return containFailure(runtime, session, "reconciliation remains uncertain");
  }
  if (classified["status"] !== "completed" || !("value" in classified)) {
    return containFailure(
      runtime,
      session,
      "reconciliation returned an invalid result",
    );
  }
  let output: unknown;
  try {
    output = await binding.parseOutput(classified["value"]);
    output = cloneJson(output as JsonValue, `${proposal.interactionId}.output`);
    const checked = await runVerification(
      runtime,
      session,
      proposal,
      binding,
      input,
      state,
      output,
      context,
    );
    if (!checked.ok) {
      return containFailure(runtime, session, checked.message, "failed");
    }
    const updatedAt = clockNow(runtime, "attempt.updatedAt");
    if (
      !(await session.transition({
        execution: "completed",
        verification: "verified",
        output: output as JsonValue,
        ...(checked.evidence === undefined ? {} : { evidence: checked.evidence }),
        message: "reconciled and verified",
        updatedAt,
      }))
    ) {
      return uncertain(session.current());
    }
  } catch (error) {
    return containFailure(
      runtime,
      session,
      messageOf(error, "reconciled output could not be verified"),
      "failed",
    );
  }
  return publishReceipt<Actor, Context, Output>(
    runtime,
    proposal,
    grant,
    session.current(),
  );
}
