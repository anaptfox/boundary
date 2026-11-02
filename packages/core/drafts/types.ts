/**
 * The host-supplied storage port behind the Draft workflow.
 *
 * `DraftStore` is the Draft workflow's equivalent of Control's journal: an interface
 * the host implements and injects. Boundary owns none of it — no schema, no
 * transaction semantics, no retention policy. `put` and `get` key exclusively
 * on `draftDigest`, so `put` MUST be idempotent: persisting the same Draft
 * digest twice must not create a second entry. `list` returns every pending
 * Draft the host is currently willing to disclose; the drafts module never
 * filters, paginates, or scopes it. `recordDecision` is a separate ledger
 * from Draft storage — accepting or rejecting a Draft never rewrites or
 * removes it from `list`, it only appends a decision the host may correlate
 * by `draftDigest`.
 */
import type { Draft, Sha256Digest } from "@foxworth/boundary/program";
import type { MaybePromise } from "@foxworth/boundary";

/** Why a Draft is rejected. Closed: a host may not invent a third reason. */
export type DraftRejectReason = "ordinary-code" | "covered-by-existing";

export const DRAFT_REJECT_REASONS: readonly DraftRejectReason[] =
  Object.freeze(["ordinary-code", "covered-by-existing"]);

export function isDraftRejectReason(
  value: unknown,
): value is DraftRejectReason {
  return (
    typeof value === "string" &&
    (DRAFT_REJECT_REASONS as readonly string[]).includes(value)
  );
}

/** One durable outcome of reviewing a Draft. Never mutates a live Program. */
export type DraftDecision =
  | Readonly<{
      status: "accepted";
      draftDigest: Sha256Digest;
      contractDigest: Sha256Digest;
      decidedBy: string;
      decidedAt: string;
    }>
  | Readonly<{
      status: "rejected";
      draftDigest: Sha256Digest;
      reason: DraftRejectReason;
      decidedBy: string;
      decidedAt: string;
    }>;

/**
 * Host-owned Draft storage and decision ledger.
 *
 * Boundary never reads or writes this data outside the three Draft interactions.
 * A host may back it with a database, a file, or memory; the drafts module
 * only ever calls these four methods.
 */
export interface DraftStore {
  /** Persists a Draft. MUST be idempotent by `draft.draftDigest`. */
  put(draft: Draft): MaybePromise<void>;
  /** Returns the Draft for an exact digest, or `undefined` if absent. */
  get(draftDigest: Sha256Digest): MaybePromise<Draft | undefined>;
  /** Returns every pending Draft. Never filtered or scoped by this module. */
  list(): MaybePromise<readonly Draft[]>;
  /** Appends one accept or reject decision. Never rewrites `list`. */
  recordDecision(decision: DraftDecision): MaybePromise<void>;
}
