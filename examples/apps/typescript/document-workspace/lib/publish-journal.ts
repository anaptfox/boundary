import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  cloneJson,
  jsonEquals,
  type JsonValue,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import {
  type Approval,
  type AttemptRecord,
  ControlError,
  type ControlJournal,
  type ControlJournalQuery,
  type ControlRecordKind,
  type ControlStatusChain,
  type CreateRecordResult,
  type Grant,
  type ProposalRecord,
  type ReceiptRecord,
} from "@foxworth/boundary/control";

const snapshot = <T>(value: T): T => cloneJson(value as JsonValue) as T;
const conflict = (message: string): never => {
  throw new ControlError("CONTROL_JOURNAL_CONFLICT", "sqlite.journal", message);
};

/**
 * `next build` opens this journal from many page-data workers at once. Switching
 * to WAL or creating the schema can report SQLITE_BUSY immediately instead of
 * waiting for busy_timeout, so setup retries briefly before giving up.
 */
function retryWhileBusy(run: () => void, budgetMs = 5000): void {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      run();
      return;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Application-owned Folio journal. SQLite transactions own uniqueness and CAS across processes. */
export class SqliteJournal implements ControlJournal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    retryWhileBusy(() => this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"));
    retryWhileBusy(() => this.db.exec(
      `CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '',
        tenant_kind TEXT, tenant_id TEXT, interaction_id TEXT, data TEXT NOT NULL,
        PRIMARY KEY(kind, id), UNIQUE(kind, digest, actor));
      CREATE INDEX IF NOT EXISTS proposals_scope ON records(kind, tenant_kind, tenant_id, id);
      CREATE INDEX IF NOT EXISTS proposals_interaction ON records(kind, tenant_kind, tenant_id, interaction_id, id);`,
    ));
  }
  close(): void {
    this.db.close();
  }
  nextId(kind: ControlRecordKind): string {
    return `${kind}-${randomUUID()}`;
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private decode<T>(row: unknown): T | undefined {
    return row === undefined
      ? undefined
      : snapshot(JSON.parse((row as { data: string }).data));
  }
  private get<T>(kind: string, id: string): T | undefined {
    return this.decode(
      this.db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(
        kind,
        id,
      ),
    );
  }
  private find<T>(kind: string, digest: string): T | undefined {
    return this.decode(
      this.db.prepare("SELECT data FROM records WHERE kind=? AND digest=?").get(
        kind,
        digest,
      ),
    );
  }
  private create<T extends { id: string; proposalDigest: string }>(
    kind: string,
    value: T,
    actor = "",
  ): CreateRecordResult<T> {
    const candidate = snapshot(value);
    return this.transaction(() => {
      const existing = this.decode<T>(
        this.db.prepare(
          "SELECT data FROM records WHERE kind=? AND digest=? AND actor=?",
        )
          .get(kind, candidate.proposalDigest, actor),
      );
      if (existing !== undefined) {
        if (
          kind === "approval" &&
          !jsonEquals(existing as JsonValue, candidate as JsonValue)
        ) conflict("approval content differs");
        return { kind: "existing", record: existing };
      }
      if (this.get(kind, candidate.id) !== undefined) {
        conflict("record id already in use");
      }
      const proposal = candidate as unknown as ProposalRecord;
      this.db.prepare(
        "INSERT INTO records(kind,id,digest,actor,tenant_kind,tenant_id,interaction_id,data) VALUES(?,?,?,?,?,?,?,?)",
      )
        .run(
          kind,
          candidate.id,
          candidate.proposalDigest,
          actor,
          proposal.subject?.kind ?? null,
          proposal.subject?.id ?? null,
          proposal.interactionId ?? null,
          JSON.stringify(candidate),
        );
      return { kind: "created", record: candidate };
    });
  }
  async createProposal(
    record: ProposalRecord,
  ): Promise<CreateRecordResult<ProposalRecord>> {
    return this.create("proposal", record);
  }
  async getProposal(id: string): Promise<ProposalRecord | undefined> {
    return this.get("proposal", id);
  }
  async findProposalByDigest(
    digest: Sha256Digest,
  ): Promise<ProposalRecord | undefined> {
    return this.find("proposal", digest);
  }
  async createApproval(
    record: Approval,
  ): Promise<CreateRecordResult<Approval>> {
    return this.create("approval", record, record.approvedBy);
  }
  async getApproval(id: string): Promise<Approval | undefined> {
    return this.get("approval", id);
  }
  async createGrant(record: Grant): Promise<CreateRecordResult<Grant>> {
    return this.create("grant", record);
  }
  async getGrant(id: string): Promise<Grant | undefined> {
    return this.get("grant", id);
  }
  async findGrantByProposalDigest(
    digest: Sha256Digest,
  ): Promise<Grant | undefined> {
    return this.find("grant", digest);
  }
  async createAttempt(
    record: AttemptRecord,
  ): Promise<CreateRecordResult<AttemptRecord>> {
    return this.create("attempt", record);
  }
  async getAttempt(id: string): Promise<AttemptRecord | undefined> {
    return this.get("attempt", id);
  }
  async findAttemptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<AttemptRecord | undefined> {
    return this.find("attempt", digest);
  }
  async createReceipt(
    record: ReceiptRecord,
  ): Promise<CreateRecordResult<ReceiptRecord>> {
    return this.create("receipt", record);
  }
  async getReceipt(id: string): Promise<ReceiptRecord | undefined> {
    return this.get("receipt", id);
  }
  async findReceiptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<ReceiptRecord | undefined> {
    return this.find("receipt", digest);
  }
  async listApprovals(digest: Sha256Digest): Promise<readonly Approval[]> {
    return this.db.prepare(
      "SELECT data FROM records WHERE kind='approval' AND digest=? ORDER BY actor COLLATE BINARY, id COLLATE BINARY",
    )
      .all(digest).map((row) => this.decode<Approval>(row)!);
  }
  async listProposals(): Promise<readonly ProposalRecord[]> {
    return this.db.prepare(
      "SELECT data FROM records WHERE kind='proposal' ORDER BY id COLLATE BINARY",
    )
      .all().map((row) => this.decode<ProposalRecord>(row)!);
  }
  async queryProposals(
    query: ControlJournalQuery,
  ): Promise<readonly ProposalRecord[]> {
    const interactions = query.interactionId === undefined
      ? query.scope.interactionIds
      : query.scope.interactionIds.includes(query.interactionId)
      ? [query.interactionId]
      : [];
    if (!interactions.length) return [];
    return this.db.prepare(
      `SELECT data FROM records WHERE kind='proposal' AND tenant_kind=? AND tenant_id=?
      AND interaction_id IN (${
        interactions.map(() => "?").join(",")
      }) AND id > ? COLLATE BINARY
      ORDER BY id COLLATE BINARY LIMIT ?`,
    ).all(
      query.scope.tenant.kind,
      query.scope.tenant.id,
      ...interactions,
      query.afterId ?? "",
      query.limit,
    ).map((row) => this.decode<ProposalRecord>(row)!);
  }
  async readStatusChains(
    digests: readonly Sha256Digest[],
  ): Promise<readonly ControlStatusChain[]> {
    if (!digests.length) return [];
    const chains = new Map(
      digests.map((proposalDigest) => [proposalDigest, { proposalDigest } as {
        proposalDigest: Sha256Digest;
        grant?: Grant;
        attempt?: AttemptRecord;
        receipt?: ReceiptRecord;
      }]),
    );
    const rows = this.db.prepare(
      `SELECT kind, digest, data FROM records WHERE kind IN ('grant','attempt','receipt')
      AND digest IN (${digests.map(() => "?").join(",")})`,
    ).all(...digests);
    for (const row of rows) {
      const chain = chains.get(row.digest as Sha256Digest)!;
      if (row.kind === "grant") chain.grant = this.decode<Grant>(row)!;
      else if (row.kind === "attempt") {
        chain.attempt = this.decode<AttemptRecord>(row)!;
      } else chain.receipt = this.decode<ReceiptRecord>(row)!;
    }
    return snapshot(digests.map((digest) => chains.get(digest)!));
  }
  async compareAndSwapAttempt(
    attempt: AttemptRecord,
    revision: number,
  ): Promise<boolean> {
    const candidate = snapshot(attempt);
    return this.transaction(() => {
      const current = this.get<AttemptRecord>("attempt", candidate.id);
      if (!current || current.recordRevision !== revision) return false;
      if (
        !Number.isInteger(revision) || candidate.recordRevision !== revision + 1
      ) conflict("revision must advance by one");
      const mutable = new Set([
        "recordRevision",
        "execution",
        "verification",
        "lease",
        "updatedAt",
        "output",
        "evidence",
        "message",
      ]);
      for (const key of Object.keys(current) as (keyof AttemptRecord)[]) {
        if (!mutable.has(key) && current[key] !== candidate[key]) {
          conflict(`immutable attempt field: ${key}`);
        }
      }
      this.db.prepare("UPDATE records SET data=? WHERE kind='attempt' AND id=?")
        .run(JSON.stringify(candidate), candidate.id);
      return true;
    });
  }
}
