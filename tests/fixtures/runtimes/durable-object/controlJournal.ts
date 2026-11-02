import { cloneJson, jsonEquals, type JsonValue, type Sha256Digest } from "@foxworth/boundary/program";
import type {
  Approval, AttemptRecord, ControlJournal, ControlJournalQuery, ControlRecordKind,
  ControlStatusChain, CreateRecordResult, Grant, ProposalRecord, ReceiptRecord,
} from "@foxworth/boundary/control";

const snapshot = <Value>(value: Value): Value => cloneJson(value as JsonValue, "workspace.control") as Value;

/** SQLite implementation of the exact Control v1 journal owned by one workspace DO. */
export class WorkspaceControlJournal implements ControlJournal {
  constructor(private readonly ctx: DurableObjectState) {}

  installSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS control_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '',
        tenant_kind TEXT, tenant_id TEXT, interaction_id TEXT, data TEXT NOT NULL,
        PRIMARY KEY(kind,id), UNIQUE(kind,digest,actor)
      );
      CREATE INDEX IF NOT EXISTS control_scope ON control_records(kind,tenant_kind,tenant_id,interaction_id,id);
    `);
  }

  nextId(kind: ControlRecordKind): string { return `${kind}-${crypto.randomUUID()}`; }
  attemptIds(): readonly string[] { return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM control_records WHERE kind='attempt'").toArray().map((row) => row.id); }
  attempts(): readonly AttemptRecord[] { return this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind='attempt'").toArray().map((row) => snapshot(JSON.parse(row.data) as AttemptRecord)); }
  effectCount(digest: Sha256Digest): number | undefined { return this.ctx.storage.sql.exec<{ count: number }>("SELECT count FROM workspace_increment_effects WHERE proposal_digest=?", digest).toArray()[0]?.count; }
  effectMatches(digest: Sha256Digest, count: number): boolean { return this.effectCount(digest) === count; }
  findAttemptByProposalDigestSync(digest: Sha256Digest): AttemptRecord | undefined { return this.#find("attempt", digest); }

  #decode<Value>(row: { data: string } | undefined): Value | undefined { return row === undefined ? undefined : snapshot(JSON.parse(row.data) as Value); }
  #get<Value>(kind: ControlRecordKind, id: string): Value | undefined { return this.#decode(this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind=? AND id=?", kind, id).toArray()[0]); }
  #find<Value>(kind: ControlRecordKind, digest: Sha256Digest): Value | undefined { return this.#decode(this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind=? AND digest=? ORDER BY actor,id", kind, digest).toArray()[0]); }
  #create<Value extends { id: string; proposalDigest: Sha256Digest }>(kind: ControlRecordKind, value: Value, actor = ""): CreateRecordResult<Value> {
    const candidate = snapshot(value);
    const existing = this.#decode<Value>(this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind=? AND digest=? AND actor=?", kind, candidate.proposalDigest, actor).toArray()[0]);
    if (existing) {
      if (kind === "approval" && !jsonEquals(existing as JsonValue, candidate as JsonValue)) throw new Error("approval digest has different content");
      return { kind: "existing", record: existing };
    }
    if (this.#get(kind, candidate.id)) throw new Error("control record id is already in use");
    const proposal = candidate as unknown as ProposalRecord;
    this.ctx.storage.sql.exec("INSERT INTO control_records(kind,id,digest,actor,tenant_kind,tenant_id,interaction_id,data) VALUES(?,?,?,?,?,?,?,?)", kind, candidate.id, candidate.proposalDigest, actor, proposal.subject?.kind ?? null, proposal.subject?.id ?? null, proposal.interactionId ?? null, JSON.stringify(candidate));
    return { kind: "created", record: candidate };
  }

  async createProposal(value: ProposalRecord) { return this.#create("proposal", value); }
  async getProposal(id: string) { return this.#get<ProposalRecord>("proposal", id); }
  async findProposalByDigest(digest: Sha256Digest) { return this.#find<ProposalRecord>("proposal", digest); }
  async listProposals() { return this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind='proposal' ORDER BY id COLLATE BINARY").toArray().map((row) => snapshot(JSON.parse(row.data) as ProposalRecord)); }
  async queryProposals(query: ControlJournalQuery) {
    const ids = query.interactionId === undefined ? query.scope.interactionIds : query.scope.interactionIds.includes(query.interactionId) ? [query.interactionId] : [];
    if (!ids.length) return [];
    return this.ctx.storage.sql.exec<{ data: string }>(`SELECT data FROM control_records WHERE kind='proposal' AND tenant_kind=? AND tenant_id=? AND interaction_id IN (${ids.map(() => "?").join(",")}) AND id>? COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT ?`, query.scope.tenant.kind, query.scope.tenant.id, ...ids, query.afterId ?? "", query.limit).toArray().map((row) => snapshot(JSON.parse(row.data) as ProposalRecord));
  }
  async createApproval(value: Approval) { return this.#create("approval", value, value.approvedBy); }
  async getApproval(id: string) { return this.#get<Approval>("approval", id); }
  async listApprovals(digest: Sha256Digest) { return this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM control_records WHERE kind='approval' AND digest=? ORDER BY actor COLLATE BINARY,id COLLATE BINARY", digest).toArray().map((row) => snapshot(JSON.parse(row.data) as Approval)); }
  async createGrant(value: Grant) { return this.#create("grant", value); }
  async getGrant(id: string) { return this.#get<Grant>("grant", id); }
  async findGrantByProposalDigest(digest: Sha256Digest) { return this.#find<Grant>("grant", digest); }
  async createAttempt(value: AttemptRecord) { return this.#create("attempt", value); }
  async getAttempt(id: string) { return this.#get<AttemptRecord>("attempt", id); }
  async findAttemptByProposalDigest(digest: Sha256Digest) { return this.#find<AttemptRecord>("attempt", digest); }
  async createReceipt(value: ReceiptRecord) { return this.#create("receipt", value); }
  async getReceipt(id: string) { return this.#get<ReceiptRecord>("receipt", id); }
  async findReceiptByProposalDigest(digest: Sha256Digest) { return this.#find<ReceiptRecord>("receipt", digest); }
  async readStatusChains(digests: readonly Sha256Digest[]): Promise<readonly ControlStatusChain[]> { return digests.map((digest) => { const grant = this.#find<Grant>("grant", digest), attempt = this.#find<AttemptRecord>("attempt", digest), receipt = this.#find<ReceiptRecord>("receipt", digest); return { proposalDigest: digest, ...(grant ? { grant } : {}), ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) }; }); }
  async compareAndSwapAttempt(value: AttemptRecord, expected: number): Promise<boolean> {
    const current = this.#get<AttemptRecord>("attempt", value.id);
    if (!current || current.recordRevision !== expected) return false;
    if (!Number.isInteger(expected) || value.recordRevision !== expected + 1) throw new Error("attempt revision must advance exactly once");
    for (const field of ["version", "proposalId", "proposalDigest", "bindingDigest", "projectionDigest", "installationId", "installationDigest", "expectedProgramDigest", "actualProgramDigest", "programDigest", "grantId", "controlDigest", "interactionId", "expectedContractDigest", "contractDigest", "requestRealizationId", "executionRealizationId", "controlRealizationDigest", "createdAt"] as const) if (value[field] !== current[field]) throw new Error(`attempt immutable field changed: ${field}`);
    this.ctx.storage.sql.exec("UPDATE control_records SET data=? WHERE kind='attempt' AND id=?", JSON.stringify(snapshot(value)), value.id);
    return true;
  }
}
