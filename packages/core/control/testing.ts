import { cloneJson, jsonEquals, type JsonValue, type Sha256Digest } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { controlReaderScopeIncludes } from "./reader-scope";
import { controlError } from "./errors";
import type {
  Approval,
  AttemptRecord,
  ControlClock,
  ControlJournalQuery,
  ControlStatusChain,
  ControlJournal,
  ControlRecordKind,
  CreateRecordResult,
  Grant,
  ProposalRecord,
  ReceiptRecord,
} from "./types";

function snapshot<Value>(value: Value, path: string): Value {
  return cloneJson(value as unknown as JsonValue, path) as unknown as Value;
}

function result<Value>(
  kind: "created" | "existing",
  record: Value,
  path: string,
): CreateRecordResult<Value> {
  return { kind, record: snapshot(record, path) };
}

function journalConflict(path: string, message: string): never {
  throw controlError("CONTROL_JOURNAL_CONFLICT", path, message);
}

function assertUnusedId<Value>(
  records: ReadonlyMap<string, Value>,
  kind: ControlRecordKind,
  id: string,
): void {
  if (records.has(id)) {
    journalConflict(
      `${kind}.id`,
      `${kind} id already belongs to another record: ${id}`,
    );
  }
}

const immutableAttemptFields = [
  "version",
  "proposalId",
  "proposalDigest",
  "bindingDigest",
  "projectionDigest",
  "installationId",
  "installationDigest",
  "expectedProgramDigest",
  "actualProgramDigest",
  "programDigest",
  "grantId",
  "controlDigest",
  "interactionId",
  "expectedContractDigest",
  "contractDigest",
  "requestRealizationId",
  "executionRealizationId",
  "controlRealizationDigest",
  "createdAt",
] as const satisfies readonly (keyof AttemptRecord)[];

/** Deterministic, independently incrementing identifiers for control fixtures. */
export class TestIds {
  readonly #counts = new Map<ControlRecordKind, number>();
  readonly #prefix: string;

  constructor(prefix = "test") {
    if (!prefix.trim()) {
      throw new TypeError("TestIds prefix must be non-empty");
    }
    this.#prefix = prefix;
  }

  nextId(kind: ControlRecordKind): string {
    const next = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, next);
    return `${this.#prefix}-${kind}-${next}`;
  }
}

/** Mutable deterministic clock for control and lease tests. */
export class TestClock implements ControlClock {
  #current: number;

  constructor(initialNow = 0) {
    this.#current = TestClock.assertTime(initialNow, "initialNow");
  }

  now(): number {
    return this.#current;
  }

  set(value: number): number {
    this.#current = TestClock.assertTime(value, "value");
    return this.#current;
  }

  advance(milliseconds: number): number {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(
        "TestClock advance must be a finite, non-negative number",
      );
    }
    return this.set(this.#current + milliseconds);
  }

  static assertTime(value: number, path: string): number {
    if (!Number.isFinite(value)) {
      throw new RangeError(`TestClock ${path} must be finite`);
    }
    return value === 0 ? 0 : value;
  }
}

/**
 * Browser-safe, process-local control journal for deterministic tests.
 *
 * Every boundary returns a fresh, deeply frozen JSON snapshot. Create methods
 * contain no suspension point, so their uniqueness checks and writes are one
 * atomic JavaScript turn.
 */
export class MemoryJournal implements ControlJournal {
  readonly #ids: TestIds;

  readonly #proposals = new Map<string, ProposalRecord>();
  readonly #proposalIdsByDigest = new Map<Sha256Digest, string>();

  readonly #approvals = new Map<string, Approval>();
  readonly #approvalIdsByProposal = new Map<
    Sha256Digest,
    Map<string, string>
  >();

  readonly #grants = new Map<string, Grant>();
  readonly #grantIdsByProposal = new Map<Sha256Digest, string>();

  readonly #attempts = new Map<string, AttemptRecord>();
  readonly #attemptIdsByProposal = new Map<Sha256Digest, string>();

  readonly #receipts = new Map<string, ReceiptRecord>();
  readonly #receiptIdsByProposal = new Map<Sha256Digest, string>();

  constructor(ids = new TestIds()) {
    this.#ids = ids;
  }

  nextId(kind: ControlRecordKind): string {
    return this.#ids.nextId(kind);
  }

  async createProposal(
    proposal: ProposalRecord,
  ): Promise<CreateRecordResult<ProposalRecord>> {
    const candidate = snapshot(proposal, "proposal");
    const existingId = this.#proposalIdsByDigest.get(
      candidate.proposalDigest,
    );
    if (existingId !== undefined) {
      return result("existing", this.#proposals.get(existingId)!, "proposal");
    }
    assertUnusedId(this.#proposals, "proposal", candidate.id);
    this.#proposals.set(candidate.id, candidate);
    this.#proposalIdsByDigest.set(candidate.proposalDigest, candidate.id);
    return result("created", candidate, "proposal");
  }

  async getProposal(id: string): Promise<ProposalRecord | undefined> {
    const record = this.#proposals.get(id);
    return record === undefined ? undefined : snapshot(record, "proposal");
  }

  async findProposalByDigest(
    digest: Sha256Digest,
  ): Promise<ProposalRecord | undefined> {
    const id = this.#proposalIdsByDigest.get(digest);
    return id === undefined
      ? undefined
      : snapshot(this.#proposals.get(id)!, "proposal");
  }

  async listProposals(): Promise<readonly ProposalRecord[]> {
    const records = [...this.#proposals.values()].sort((left, right) =>
      compareUtf8(left.id, right.id),
    );
    return snapshot(records, "proposals");
  }

  async queryProposals(query: ControlJournalQuery): Promise<readonly ProposalRecord[]> {
    return snapshot([...this.#proposals.values()].filter((row) =>
      controlReaderScopeIncludes(query.scope, row) &&
      (query.interactionId === undefined || row.interactionId === query.interactionId) &&
      (query.afterId === undefined || compareUtf8(row.id, query.afterId) > 0))
      .sort((left, right) => compareUtf8(left.id, right.id)).slice(0, query.limit), "proposals");
  }

  async readStatusChains(digests: readonly Sha256Digest[]): Promise<readonly ControlStatusChain[]> {
    return snapshot(digests.map((proposalDigest) => {
      const grantId = this.#grantIdsByProposal.get(proposalDigest);
      const attemptId = this.#attemptIdsByProposal.get(proposalDigest);
      const receiptId = this.#receiptIdsByProposal.get(proposalDigest);
      return { proposalDigest,
        ...(grantId === undefined ? {} : { grant: this.#grants.get(grantId)! }),
        ...(attemptId === undefined ? {} : { attempt: this.#attempts.get(attemptId)! }),
        ...(receiptId === undefined ? {} : { receipt: this.#receipts.get(receiptId)! }) };
    }), "chains");
  }

  async createApproval(
    approval: Approval,
  ): Promise<CreateRecordResult<Approval>> {
    const candidate = snapshot(approval, "approval");
    const byActor = this.#approvalIdsByProposal.get(candidate.proposalDigest);
    const existingId = byActor?.get(candidate.approvedBy);
    if (existingId !== undefined) {
      const existing = this.#approvals.get(existingId)!;
      if (
        !jsonEquals(
          existing as unknown as JsonValue,
          candidate as unknown as JsonValue,
        )
      ) {
        journalConflict(
          `approval.${candidate.id}`,
          "approval already exists for this proposal and actor with different content",
        );
      }
      return result("existing", existing, "approval");
    }
    assertUnusedId(this.#approvals, "approval", candidate.id);
    this.#approvals.set(candidate.id, candidate);
    const actorIndex = byActor ?? new Map<string, string>();
    actorIndex.set(candidate.approvedBy, candidate.id);
    if (byActor === undefined) {
      this.#approvalIdsByProposal.set(candidate.proposalDigest, actorIndex);
    }
    return result("created", candidate, "approval");
  }

  async listApprovals(
    proposalDigest: Sha256Digest,
  ): Promise<readonly Approval[]> {
    const byActor = this.#approvalIdsByProposal.get(proposalDigest);
    if (byActor === undefined) return Object.freeze([]);
    const records = [...byActor.values()]
      .map((id) => this.#approvals.get(id)!)
      .sort(
        (left, right) =>
          compareUtf8(left.approvedBy, right.approvedBy) ||
          compareUtf8(left.id, right.id),
      );
    return snapshot(records, "approvals");
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const record = this.#approvals.get(id);
    return record === undefined ? undefined : snapshot(record, "approval");
  }

  async createGrant(grant: Grant): Promise<CreateRecordResult<Grant>> {
    const candidate = snapshot(grant, "grant");
    const existingId = this.#grantIdsByProposal.get(candidate.proposalDigest);
    if (existingId !== undefined) {
      return result("existing", this.#grants.get(existingId)!, "grant");
    }
    assertUnusedId(this.#grants, "grant", candidate.id);
    this.#grants.set(candidate.id, candidate);
    this.#grantIdsByProposal.set(candidate.proposalDigest, candidate.id);
    return result("created", candidate, "grant");
  }

  async getGrant(id: string): Promise<Grant | undefined> {
    const record = this.#grants.get(id);
    return record === undefined ? undefined : snapshot(record, "grant");
  }

  async findGrantByProposalDigest(
    digest: Sha256Digest,
  ): Promise<Grant | undefined> {
    const id = this.#grantIdsByProposal.get(digest);
    return id === undefined
      ? undefined
      : snapshot(this.#grants.get(id)!, "grant");
  }

  async createAttempt(
    attempt: AttemptRecord,
  ): Promise<CreateRecordResult<AttemptRecord>> {
    const candidate = snapshot(attempt, "attempt");
    const existingId = this.#attemptIdsByProposal.get(candidate.proposalDigest);
    if (existingId !== undefined) {
      return result("existing", this.#attempts.get(existingId)!, "attempt");
    }
    assertUnusedId(this.#attempts, "attempt", candidate.id);
    this.#attempts.set(candidate.id, candidate);
    this.#attemptIdsByProposal.set(candidate.proposalDigest, candidate.id);
    return result("created", candidate, "attempt");
  }

  async compareAndSwapAttempt(
    attempt: AttemptRecord,
    expectedRecordRevision: number,
  ): Promise<boolean> {
    const candidate = snapshot(attempt, "attempt");
    const current = this.#attempts.get(candidate.id);
    if (
      current === undefined ||
      current.recordRevision !== expectedRecordRevision
    ) {
      return false;
    }

    if (
      !Number.isInteger(expectedRecordRevision) ||
      candidate.recordRevision !== expectedRecordRevision + 1
    ) {
      journalConflict(
        "attempt.recordRevision",
        `attempt revision must advance exactly from ${expectedRecordRevision} to ${expectedRecordRevision + 1}`,
      );
    }

    for (const field of immutableAttemptFields) {
      if (candidate[field] !== current[field]) {
        journalConflict(
          `attempt.${field}`,
          `attempt ${field} is immutable after creation`,
        );
      }
    }

    this.#attempts.set(candidate.id, candidate);
    return true;
  }

  async getAttempt(id: string): Promise<AttemptRecord | undefined> {
    const record = this.#attempts.get(id);
    return record === undefined ? undefined : snapshot(record, "attempt");
  }

  async findAttemptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<AttemptRecord | undefined> {
    const id = this.#attemptIdsByProposal.get(digest);
    return id === undefined
      ? undefined
      : snapshot(this.#attempts.get(id)!, "attempt");
  }

  async createReceipt(
    receipt: ReceiptRecord,
  ): Promise<CreateRecordResult<ReceiptRecord>> {
    const candidate = snapshot(receipt, "receipt");
    const existingId = this.#receiptIdsByProposal.get(
      candidate.proposalDigest,
    );
    if (existingId !== undefined) {
      return result("existing", this.#receipts.get(existingId)!, "receipt");
    }
    assertUnusedId(this.#receipts, "receipt", candidate.id);
    this.#receipts.set(candidate.id, candidate);
    this.#receiptIdsByProposal.set(candidate.proposalDigest, candidate.id);
    return result("created", candidate, "receipt");
  }

  async getReceipt(id: string): Promise<ReceiptRecord | undefined> {
    const record = this.#receipts.get(id);
    return record === undefined ? undefined : snapshot(record, "receipt");
  }

  async findReceiptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<ReceiptRecord | undefined> {
    const id = this.#receiptIdsByProposal.get(digest);
    return id === undefined
      ? undefined
      : snapshot(this.#receipts.get(id)!, "receipt");
  }
}
