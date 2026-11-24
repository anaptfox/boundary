/**
 * The business logic behind the three Draft interactions, factored out of
 * `defineInteraction` wiring so a host can call it directly (as these tests
 * do) or hand it to `implementInteractions`/a Control-style request
 * contribution.
 *
 * Every function here talks to a host-supplied {@link DraftStore} and
 * nothing else. None of them ever touches a Program, an Installation, or a
 * source file: turning an accepted Draft into a declared interaction remains
 * the host's separate, ordinary recompilation.
 */
import {
  digestInteractionContract,
  isSha256Digest,
  verifyDraft,
  type Draft,
  type JsonObject,
  type InteractionContract,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import { declaredInteractionError } from "@foxworth/boundary";
import { InteractionFault } from "@foxworth/boundary";
import type { MaybePromise } from "@foxworth/boundary";
import { draftsAccept, draftsPropose, draftsReject } from "./definitions";
import {
  isDraftRejectReason,
  type DraftRejectReason,
  type DraftStore,
} from "./types";

/** Wire shape of {@link Draft} accepted by `drafts.propose`. */
export interface DraftInput {
  readonly version: 1;
  readonly contract: JsonObject;
  readonly gap: string;
  readonly proposer: string;
  readonly createdAt: string;
  readonly draftDigest: string;
}

export interface DraftProposeOutput {
  readonly draftDigest: Sha256Digest;
}

export interface DraftDecisionInput {
  readonly draftDigest: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface DraftAcceptOutput {
  readonly contract: InteractionContract;
  readonly contractDigest: Sha256Digest;
}

export interface DraftRejectInput extends DraftDecisionInput {
  readonly reason: string;
}

export interface DraftRejectOutput {
  readonly draftDigest: Sha256Digest;
  readonly reason: DraftRejectReason;
}

function requireDraftDigest(
  value: string,
  fail: (message: string) => never,
): Sha256Digest {
  if (!isSha256Digest(value)) {
    fail(`draftDigest is not a valid digest: ${value}`);
  }
  return value;
}

async function readFault<Value>(
  action: () => MaybePromise<Value>,
  message: string,
): Promise<Value> {
  try {
    return await action();
  } catch (cause) {
    throw new InteractionFault(
      "realization-failed",
      "not-started",
      message,
      cause instanceof Error ? { message: cause.message } : null,
    );
  }
}

async function writeFault(
  action: () => MaybePromise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (cause) {
    throw new InteractionFault(
      "realization-failed",
      "unknown",
      message,
      cause instanceof Error ? { message: cause.message } : null,
    );
  }
}

/**
 * `drafts.propose`: verify and persist a Draft. Direct mode. Never reads or
 * writes anything beyond `store.put`, and therefore never changes
 * what is declared.
 */
export async function proposeDraft(
  store: DraftStore,
  input: DraftInput,
): Promise<DraftProposeOutput> {
  const draftDigest = requireDraftDigest(input.draftDigest, (message) => {
    throw declaredInteractionError(draftsPropose, "invalidDraft", { message });
  });
  const draft: Draft = Object.freeze({
    version: 1,
    contract: input.contract as unknown as InteractionContract,
    gap: input.gap,
    proposer: input.proposer,
    createdAt: input.createdAt,
    draftDigest,
  });
  try {
    verifyDraft(draft);
  } catch (cause) {
    throw declaredInteractionError(draftsPropose, "invalidDraft", {
      message: cause instanceof Error ? cause.message : "invalid draft",
    });
  }
  await writeFault(
    () => store.put(draft),
    "the draft store failed to persist a proposed draft",
  );
  return Object.freeze({ draftDigest });
}

/**
 * Looks up a Draft by digest and proves it is that Draft.
 *
 * A malformed digest and an absent digest are both reported through the same
 * `draftNotFound` details: from the caller's side, an ill-formed reference
 * and a missing one are indistinguishable.
 *
 * A Draft that is present but does not verify, or verifies as a *different*
 * Draft, is neither of those. The store is host-supplied and the decisions
 * are request mode, so what a person approved is a digest, not a contract.
 * Verifying alone catches a tampered Draft but not a substituted one — a
 * self-consistent Draft filed under someone else's digest verifies perfectly
 * well. Both are faults rather than declared errors, and mirror
 * `DraftFault::InvalidDraft` and `DraftFault::DraftSubstituted` in
 * `crates/boundary-core/src/lifecycle/drafts.rs`.
 */
async function requireDraft(
  store: DraftStore,
  rawDraftDigest: string,
  fail: (details: JsonObject) => never,
): Promise<Draft> {
  if (!isSha256Digest(rawDraftDigest)) {
    fail({ draftDigest: rawDraftDigest });
  }
  const draft = await readFault(
    () => store.get(rawDraftDigest),
    "the draft store failed to look up a draft",
  );
  if (draft === undefined) {
    fail({ draftDigest: rawDraftDigest });
  }
  try {
    verifyDraft(draft);
  } catch (cause) {
    throw new InteractionFault(
      "realization-failed",
      "not-started",
      `the stored draft ${rawDraftDigest} no longer verifies`,
      cause instanceof Error ? { message: cause.message } : null,
    );
  }
  if (draft.draftDigest !== rawDraftDigest) {
    throw new InteractionFault(
      "realization-failed",
      "not-started",
      `draft ${rawDraftDigest} is stored as ${draft.draftDigest}; the approval names content it was never bound to`,
      { requested: rawDraftDigest, stored: draft.draftDigest },
    );
  }
  return draft;
}

/**
 * `drafts.accept`: request mode by default. Returns the accepted contract
 * and its digest and records the decision. It never mutates a live Program
 * and never writes source files.
 */
export async function acceptDraft(
  store: DraftStore,
  input: DraftDecisionInput,
): Promise<DraftAcceptOutput> {
  const draft = await requireDraft(store, input.draftDigest, (details) => {
    throw declaredInteractionError(draftsAccept, "draftNotFound", details);
  });
  const contractDigest = digestInteractionContract(draft.contract);
  await writeFault(
    () =>
      store.recordDecision(
        Object.freeze({
          status: "accepted",
          draftDigest: draft.draftDigest,
          contractDigest,
          decidedBy: input.decidedBy,
          decidedAt: input.decidedAt,
        }),
      ),
    "the draft store failed to record an acceptance decision",
  );
  return Object.freeze({ contract: draft.contract, contractDigest });
}

/**
 * `drafts.reject`: request mode by default. Takes a reason from the closed
 * set `ordinary-code` | `covered-by-existing` and records the decision.
 */
export async function rejectDraft(
  store: DraftStore,
  input: DraftRejectInput,
): Promise<DraftRejectOutput> {
  if (!isDraftRejectReason(input.reason)) {
    throw declaredInteractionError(draftsReject, "invalidReason", {
      reason: input.reason,
    });
  }
  const reason = input.reason;
  const draft = await requireDraft(store, input.draftDigest, (details) => {
    throw declaredInteractionError(draftsReject, "draftNotFound", details);
  });
  await writeFault(
    () =>
      store.recordDecision(
        Object.freeze({
          status: "rejected",
          draftDigest: draft.draftDigest,
          reason,
          decidedBy: input.decidedBy,
          decidedAt: input.decidedAt,
        }),
      ),
    "the draft store failed to record a rejection decision",
  );
  return Object.freeze({ draftDigest: draft.draftDigest, reason });
}
