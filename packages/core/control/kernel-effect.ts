import { cloneJson, jsonEquals, type JsonValue } from "@foxworth/boundary/program";
import { controlError } from "./errors";
import {
  attemptMatches,
  attemptRefMatches,
  grantMatchesProposal,
  publicAttempt,
  publicProposal,
  receiptMatches,
  snapshot,
  snapshotAttemptRecord,
  snapshotReceiptRecord,
} from "./records";
import {
  beforeAttempt,
  clockNow,
  loadProposalRecord,
  nextId,
  parsePrivateProposal,
  resolveCurrentBinding,
  snapshotCreateResult,
  targetOf,
  type ControlRuntime,
} from "./kernel-shared";
import { CONTROL_RECORD_VERSION } from "./types";
import type {
  AttemptRef,
  UntypedAttemptRef,
  AttemptRecord,
  ControlBinding,
  ControlLease,
  EffectResult,
  Grant,
  LeaseSnapshot,
  ProposalRecord,
  ReceiptRecord,
  Verification,
} from "./types";

const DEFAULT_LEASE_MS = 30_000;

export function leaseDuration<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
): number {
  const value = runtime.lease?.durationMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw controlError(
      "CONTROL_INVALID_LEASE",
      "control.lease.durationMs",
      "lease duration must be a positive finite number",
    );
  }
  return value;
}

export function uncertain<Output = never>(
  attempt: AttemptRecord,
): EffectResult<Output> {
  // Runtime identity validation remains authoritative. The calling kernel carries
  // the native output relation; projecting a durable record alone stays unknown.
  return Object.freeze({
    status: "uncertain",
    attempt: publicAttempt(attempt) as AttemptRef<Output>,
  });
}

export function notApplied(reason: string): EffectResult<never> {
  return Object.freeze({ status: "not-applied", reason });
}

async function completed<Context, Output>(
  binding: ControlBinding<Context>,
  receipt: ReceiptRecord,
): Promise<EffectResult<Output>> {
  const durableReceipt = snapshotReceiptRecord(receipt);
  const value = await binding.parseOutput(durableReceipt.output);
  return Object.freeze({
    status: "completed" as const,
    value: value as Output,
    receipt: durableReceipt,
  });
}

export async function loadAuthority<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  grantHandle: Grant | string,
): Promise<{
  readonly proposal: ProposalRecord;
  readonly grant: Grant;
}> {
  const grantId = typeof grantHandle === "string" ? grantHandle : grantHandle.id;
  let grant: Grant | undefined;
  try {
    const loaded = await runtime.journal.getGrant(grantId);
    grant = loaded === undefined ? undefined : snapshot(loaded, "grant");
  } catch (error) {
    throw beforeAttempt(error, `grant.${grantId}`, "grant lookup failed");
  }
  if (!grant) {
    throw controlError(
      "CONTROL_UNKNOWN_GRANT",
      `grant.${grantId}`,
      `unknown grant: ${grantId}`,
    );
  }
  if (grant.id !== grantId) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `grant.${grantId}`,
      "journal grant id does not match its requested key",
    );
  }
  if (
    typeof grantHandle !== "string" &&
    !jsonEquals(
      grantHandle as unknown as JsonValue,
      grant as unknown as JsonValue,
    )
  ) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `grant.${grantId}`,
      "grant handle does not match its durable record",
    );
  }
  const proposal = await loadProposalRecord(runtime, grant.proposalId);
  if (!grantMatchesProposal(grant, proposal)) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `grant.${grant.id}`,
      "grant does not bind the exact proposal",
    );
  }
  return { proposal, grant: snapshot(grant, "grant") };
}

export async function bindPrivateProposal<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  proposal: ProposalRecord,
  path: string,
): Promise<{
  readonly binding: ControlBinding<Context>;
  readonly input: unknown;
  readonly state: JsonValue;
}> {
  const binding = await resolveCurrentBinding(
    runtime.host,
    targetOf(proposal),
    path,
  );
  const parsed = await parsePrivateProposal(binding, proposal);
  return { binding, input: parsed.input, state: parsed.state };
}

export async function findExistingAttempt<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  proposal: ProposalRecord,
): Promise<AttemptRecord | undefined> {
  try {
    const attempt = await runtime.journal.findAttemptByProposalDigest(
      proposal.proposalDigest,
    );
    return attempt === undefined ? undefined : snapshotAttemptRecord(attempt);
  } catch (error) {
    throw beforeAttempt(error, "attempt", "attempt lookup failed");
  }
}

export async function findExistingReceipt<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  proposal: ProposalRecord,
): Promise<ReceiptRecord | undefined> {
  try {
    const receipt = await runtime.journal.findReceiptByProposalDigest(
      proposal.proposalDigest,
    );
    return receipt === undefined
      ? undefined
      : snapshotReceiptRecord(receipt);
  } catch (error) {
    throw beforeAttempt(error, "receipt", "receipt lookup failed");
  }
}

export async function publishReceipt<Actor, Context, Output>(
  runtime: ControlRuntime<Actor, Context>,
  proposal: ProposalRecord,
  grant: Grant,
  attempt: AttemptRecord,
): Promise<EffectResult<Output>> {
  let binding: ControlBinding<Context>;
  try {
    binding = await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.receipt",
    );
  } catch {
    return uncertain(attempt);
  }
  if (
    attempt.execution !== "completed" ||
    attempt.verification !== "verified" ||
    attempt.output === undefined
  ) {
    return uncertain(attempt);
  }
  let existing: ReceiptRecord | undefined;
  try {
    const found = await runtime.journal.findReceiptByProposalDigest(
      proposal.proposalDigest,
    );
    existing = found === undefined ? undefined : snapshotReceiptRecord(found);
  } catch {
    return uncertain(attempt);
  }
  if (existing) {
    if (!receiptMatches(existing, attempt, proposal, grant)) {
      return uncertain(attempt);
    }
    try {
      binding = await resolveCurrentBinding(
        runtime.host,
        targetOf(proposal),
        "control.receipt",
      );
      return await completed<Context, Output>(binding, existing);
    } catch {
      return uncertain(attempt);
    }
  }
  let receipt: ReceiptRecord;
  try {
    receipt = Object.freeze({
      version: CONTROL_RECORD_VERSION,
      id: await nextId(runtime, "receipt"),
      attemptId: attempt.id,
      proposalId: proposal.id,
      proposalDigest: proposal.proposalDigest,
      grantId: grant.id,
      ...targetOf(proposal),
      output: snapshot(attempt.output, "receipt.output"),
      ...(attempt.evidence === undefined
        ? {}
        : { evidence: snapshot(attempt.evidence, "receipt.evidence") }),
      completedAt: clockNow(runtime, "receipt.completedAt"),
    });
    const created = snapshotCreateResult(
      await runtime.journal.createReceipt(receipt),
      `receipt.${receipt.id}.create`,
    );
    const durableReceipt = snapshotReceiptRecord(
      created.record,
      `receipt.${receipt.id}`,
    );
    if (
      (created.kind === "created" &&
        !jsonEquals(
          durableReceipt as unknown as JsonValue,
          receipt as unknown as JsonValue,
        )) ||
      !receiptMatches(durableReceipt, attempt, proposal, grant)
    ) {
      return uncertain(attempt);
    }
    binding = await resolveCurrentBinding(
      runtime.host,
      targetOf(proposal),
      "control.receipt",
    );
    return await completed<Context, Output>(binding, durableReceipt);
  } catch {
    try {
      const found = await runtime.journal.findReceiptByProposalDigest(
        proposal.proposalDigest,
      );
      const recovered =
        found === undefined ? undefined : snapshotReceiptRecord(found);
      if (recovered && receiptMatches(recovered, attempt, proposal, grant)) {
        binding = await resolveCurrentBinding(
          runtime.host,
          targetOf(proposal),
          "control.receipt",
        );
        return await completed<Context, Output>(binding, recovered);
      }
    } catch {
      // The receipt commit is ambiguous, so uncertainty is the only safe result.
    }
    return uncertain(attempt);
  }
}

function verification(value: unknown): Verification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verification must return {ok:true} or {ok:false,message}");
  }
  const result = value as Record<string, unknown>;
  if (result["ok"] === true) {
    return Object.freeze({
      ok: true,
      ...(result["evidence"] === undefined
        ? {}
        : { evidence: cloneJson(result["evidence"] as JsonValue, "verification.evidence") }),
    });
  }
  if (result["ok"] === false && typeof result["message"] === "string") {
    return Object.freeze({
      ok: false,
      message: result["message"],
      ...(result["evidence"] === undefined
        ? {}
        : { evidence: cloneJson(result["evidence"] as JsonValue, "verification.evidence") }),
    });
  }
  throw new Error("verification must return {ok:true} or {ok:false,message}");
}

export type AttemptSession = {
  current(): AttemptRecord;
  transition(
    patch: Partial<Omit<AttemptRecord, "recordRevision">>,
  ): Promise<boolean>;
  lease: ControlLease;
};

export function createAttemptSession<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  initial: AttemptRecord,
): AttemptSession {
  let current = initial;
  const transition = async (
    patch: Partial<Omit<AttemptRecord, "recordRevision">>,
  ): Promise<boolean> => {
    const next: AttemptRecord = Object.freeze({
      ...current,
      ...patch,
      recordRevision: current.recordRevision + 1,
    });
    const ok = await runtime.journal.compareAndSwapAttempt(
      next,
      current.recordRevision,
    );
    if (ok) current = next;
    return ok;
  };
  const lease = Object.freeze({
    get owner() {
      return current.lease.owner;
    },
    get expiresAt() {
      return current.lease.expiresAt;
    },
    get fence() {
      return current.lease.fence;
    },
    async renew(): Promise<LeaseSnapshot> {
      const now = clockNow(runtime, "attempt.lease.renewedAt");
      if (current.lease.owner !== runtime.executor.owner) {
        throw controlError(
          "CONTROL_INVALID_LEASE",
          "attempt.lease.owner",
          "only the current executor may renew a lease",
        );
      }
      if (now >= current.lease.expiresAt) {
        throw controlError(
          "CONTROL_INVALID_LEASE",
          "attempt.lease.expiresAt",
          "an expired lease cannot be renewed",
        );
      }
      const renewed = Object.freeze({
        owner: runtime.executor.owner,
        expiresAt: now + leaseDuration(runtime),
        fence: current.lease.fence + 1,
      });
      if (!(await transition({ lease: renewed, updatedAt: now }))) {
        throw controlError(
          "CONTROL_JOURNAL_CONFLICT",
          "attempt.lease",
          "lease renewal lost its compare-and-swap",
        );
      }
      return renewed;
    },
  });
  return Object.freeze({ current: () => current, transition, lease });
}

export async function containFailure<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  session: AttemptSession,
  message: string,
  verificationState: AttemptRecord["verification"] = "pending",
): Promise<EffectResult<never>> {
  const now = (() => {
    try {
      return clockNow(runtime, "attempt.updatedAt");
    } catch {
      return session.current().updatedAt;
    }
  })();
  const local: AttemptRecord = Object.freeze({
    ...session.current(),
    execution: "uncertain",
    verification: verificationState,
    message,
    updatedAt: now,
    recordRevision: session.current().recordRevision + 1,
  });
  try {
    if (
      await runtime.journal.compareAndSwapAttempt(
        local,
        session.current().recordRevision,
      )
    ) {
      return uncertain(local);
    }
  } catch {
    // Durable state is ambiguous after the attempt boundary.
  }
  return uncertain(session.current());
}

export async function runVerification<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  session: AttemptSession,
  proposal: ProposalRecord,
  binding: ControlBinding<Context>,
  input: unknown,
  state: JsonValue,
  output: unknown,
  context: Context,
): Promise<Verification> {
  const raw = await binding.hook.verify({
    input,
    state,
    proposal: publicProposal(proposal),
    lease: session.lease,
    output,
    context,
  });
  return verification(raw);
}

export async function loadAttemptRecord<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  handle: UntypedAttemptRef | string,
): Promise<AttemptRecord> {
  const id = typeof handle === "string" ? handle : handle.id;
  let attempt: AttemptRecord | undefined;
  try {
    const loaded = await runtime.journal.getAttempt(id);
    attempt = loaded === undefined ? undefined : snapshotAttemptRecord(loaded);
  } catch (error) {
    throw beforeAttempt(error, `attempt.${id}`, "attempt lookup failed");
  }
  if (!attempt) {
    throw controlError(
      "CONTROL_UNKNOWN_ATTEMPT",
      `attempt.${id}`,
      `unknown attempt: ${id}`,
    );
  }
  if (attempt.id !== id) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `attempt.${id}`,
      "journal attempt id does not match its requested key",
    );
  }
  if (typeof handle !== "string" && !attemptRefMatches(handle, attempt)) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `attempt.${attempt.id}`,
      "attempt handle does not match its durable record",
    );
  }
  return attempt;
}

export async function loadAttemptAuthority<Actor, Context>(
  runtime: ControlRuntime<Actor, Context>,
  attempt: AttemptRecord,
): Promise<{
  readonly proposal: ProposalRecord;
  readonly grant: Grant;
}> {
  const loaded = await loadAuthority(runtime, attempt.grantId);
  if (!attemptMatches(attempt, loaded.proposal, loaded.grant)) {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      `attempt.${attempt.id}`,
      "attempt does not match exact authority",
    );
  }
  return loaded;
}
