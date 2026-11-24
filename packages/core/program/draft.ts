/**
 * The interaction Draft: a bot proposes a contract that does not exist yet.
 *
 * "Proposal" already names Control's pending effect, so a contract that does
 * not yet exist gets its own word. A Draft wraps a FULL interaction contract —
 * the entire declared identity in {@link InteractionContract}, never a
 * fragment — because anything less would fork contract identity, which is
 * the whole thing to avoid. It adds only what a proposal needs on top: the
 * gap the contract would fill (`gap`), who proposed it (`proposer`, an
 * opaque host-supplied string), and when (`createdAt`, a host-supplied
 * ISO-8601 timestamp).
 *
 * A Draft is not a Program entry. {@link Program} never contains one, and
 * nothing here is callable. It is an inert artifact: a person still reviews
 * it and, if accepted, a host still declares the contract through the
 * ordinary {@link InteractionContract} path. Declaration remains distinct from
 * realization, and interfaces still narrow authority rather than invent it.
 *
 * Boundary never reads a clock internally; ambient time would be unreviewable,
 * silently varying input, so `createdAt` is host-supplied and only checked
 * for shape here.
 *
 * This is a from-scratch TypeScript port of the algorithm in
 * `crates/boundary-core/src/program/draft.rs`. It must produce byte-identical
 * digests for the same input; the shared conformance vector is the check,
 * not this comment.
 */
import { BoundaryErrorBase } from "./errors";
import {
  hashJson,
  type DomainHasher,
  type JsonObject,
  type Sha256Digest,
} from "./json";
import { interactionContractIdentity, type InteractionContract } from "./program";

/** Identity domain for a Draft. */
export const INTERACTION_DRAFT_DOMAIN = "boundary.interaction-draft/v1";

/** Why a Draft cannot be built, or a draft that failed to verify. */
export type DraftDiagnosticCode =
  | "EMPTY_GAP"
  | "EMPTY_PROPOSER"
  | "INVALID_CREATED_AT"
  | "DIGEST_MISMATCH";

/** A Draft that cannot be built, or a draft that failed to verify. */
export class DraftError extends BoundaryErrorBase {
  declare readonly code: DraftDiagnosticCode;

  constructor(code: DraftDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "DraftError";
  }
}

function fail(code: DraftDiagnosticCode, path: string, message: string): never {
  throw new DraftError(code, path, message);
}

/** Inputs for {@link createDraft}. The contract is validated the same way
 * Program validates every interaction contract; an invalid contract throws the
 * same error `@foxworth/boundary/program`'s contract path already throws. */
export type DraftSource = {
  readonly contract: InteractionContract;
  readonly gap: string;
  readonly proposer: string;
  readonly createdAt: string;
};

/** An inert artifact proposing a full interaction contract that does not exist yet. */
export type Draft = {
  readonly version: 1;
  readonly contract: InteractionContract;
  readonly gap: string;
  readonly proposer: string;
  readonly createdAt: string;
  readonly draftDigest: Sha256Digest;
};

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const OFFSET_PATTERN = /^[+-](\d{2}):(\d{2})$/u;

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Validates the strict ISO-8601 shape a Draft's `createdAt` requires:
 * `YYYY-MM-DDTHH:MM:SS[.f+](Z|(+|-)HH:MM)`, with calendar-aware
 * day-of-month bounds and a leap-second allowance on the seconds field.
 *
 * This is a from-scratch port of `crates/boundary-core/src/program/timestamp.rs`.
 */
export function isValidDraftTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 60) return false;
  if (offset === "Z") return true;
  const offsetMatch = OFFSET_PATTERN.exec(offset ?? "");
  if (offsetMatch === null) return false;
  const [, offsetHourText, offsetMinuteText] = offsetMatch;
  return Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59;
}

function draftIdentity(
  contract: InteractionContract,
  gap: string,
  proposer: string,
  createdAt: string,
): JsonObject {
  return {
    version: 1,
    contract: interactionContractIdentity(contract) as unknown as JsonObject,
    gap,
    proposer,
    createdAt,
  };
}

/**
 * Builds and validates a Draft, computing its digest.
 *
 * @throws {DraftError} when `gap` or `proposer` is empty, or `createdAt` is
 * not a valid ISO-8601 timestamp.
 */
export function createDraft(
  source: DraftSource,
  hasher: DomainHasher = hashJson,
): Draft {
  const gap = source.gap;
  if (gap.trim() === "") {
    fail("EMPTY_GAP", "draft.gap", "a draft's gap explanation must not be empty");
  }

  const proposer = source.proposer;
  if (proposer.trim() === "") {
    fail("EMPTY_PROPOSER", "draft.proposer", "a draft's proposer must not be empty");
  }

  const createdAt = source.createdAt;
  if (!isValidDraftTimestamp(createdAt)) {
    fail(
      "INVALID_CREATED_AT",
      "draft.createdAt",
      "a draft's createdAt must be a valid ISO-8601 timestamp",
    );
  }

  // Validates and normalizes the contract the same way Program does; throws
  // ProgramError (not DraftError) on an invalid contract.
  const contract = interactionContractIdentity(source.contract);

  const draftDigest = hasher(
    INTERACTION_DRAFT_DOMAIN,
    draftIdentity(contract, gap, proposer, createdAt),
  );

  return Object.freeze({
    version: 1,
    contract,
    gap,
    proposer,
    createdAt,
    draftDigest,
  });
}

/**
 * Recomputes and checks the digest of a Draft that crossed a boundary.
 *
 * @throws {DraftError} with code `DIGEST_MISMATCH` when the draft's recorded
 * digest does not match its content.
 */
export function verifyDraft(
  draft: Draft,
  hasher: DomainHasher = hashJson,
): void {
  const recomputed = hasher(
    INTERACTION_DRAFT_DOMAIN,
    draftIdentity(draft.contract, draft.gap, draft.proposer, draft.createdAt),
  );
  if (recomputed !== draft.draftDigest) {
    fail(
      "DIGEST_MISMATCH",
      "draft.draftDigest",
      `draft digest mismatch: recorded ${draft.draftDigest}, recomputed ${recomputed}`,
    );
  }
}
