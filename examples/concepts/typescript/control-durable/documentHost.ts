import { createControlCapabilities, type ControlHook, type ControlHost, type ControlPolicy, type ControlTarget } from "../../../../packages/core/control/index";
import type { Sha256Digest } from "@foxworth/boundary/program";
import { SqliteJournal } from "./sqliteJournal";

const digest = (value: string): Sha256Digest => `sha256:${value.repeat(64)}`;
export const target: ControlTarget = {
  bindingDigest: digest("1"), projectionDigest: digest("2"), installationId: "document-host",
  installationDigest: digest("3"), expectedProgramDigest: digest("4"), actualProgramDigest: digest("4"),
  programDigest: digest("4"), interactionId: "document.replace", expectedContractDigest: digest("5"),
  contractDigest: digest("5"), requestRealizationId: "request", executionRealizationId: "execute",
  controlRealizationDigest: digest("6"), controlDigest: digest("7"),
};
export const scope = { interactionIds: [target.interactionId], tenant: { kind: "document", id: "one" } };
const allow: ControlPolicy<string> = {
  identify: (actor) => actor, request: () => ({ allow: true }), approve: () => ({ allow: true }),
  grant: () => ({ allow: true }), execute: () => ({ allow: true }), reconcile: () => ({ allow: true }),
  preflight() {},
};
function body(value: unknown): { body: string } {
  if (typeof value !== "object" || value === null || !("body" in value) || typeof value.body !== "string") throw new TypeError("body required");
  return { body: value.body };
}

/** The application owns mutation and checks the exact durable lease in its transaction. */
export function documentHost(journal: SqliteJournal, now: () => number, options: {
  owner?: string;
  afterEffect?: () => void;
  beforeEffect?: () => Promise<void>;
} = {}) {
  journal.db.exec(`CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY, body TEXT NOT NULL, applications INTEGER NOT NULL);
    INSERT OR IGNORE INTO document VALUES (1, 'before', 0);
    CREATE TABLE IF NOT EXISTS effects (proposal_digest TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  const read = () => journal.db.prepare("SELECT body, applications FROM document WHERE id=1").get() as { body: string; applications: number };
  const effect = (proposalDigest: string) => journal.db.prepare("SELECT body FROM effects WHERE proposal_digest=?").get(proposalDigest) as { body: string } | undefined;
  const hook: ControlHook<{ body: string }, { body: string }, { body: string }, { body: string }, unknown, unknown, undefined> = {
    realizationDigest: target.controlRealizationDigest, state: {}, preview: {},
    plan: ({ input }) => ({ subject: scope.tenant, baseline: { body: read().body }, baselineSummary: "current body",
      effects: [{ kind: "sqlite", action: "replace", resource: "document/one" }], state: { body: read().body }, preview: input }),
    async apply({ input, proposal, lease }) {
      await options.beforeEffect?.();
      journal.transaction(() => {
        const row = journal.db.prepare("SELECT data FROM records WHERE kind='attempt' AND digest=?").get(proposal.proposalDigest) as { data: string } | undefined;
        const persisted = row === undefined ? undefined : JSON.parse(row.data);
        if (!persisted || persisted.lease.fence !== lease.fence || persisted.lease.owner !== lease.owner ||
            persisted.lease.expiresAt <= now() || persisted.execution !== "started") throw new Error("stale executor fence");
        if (effect(proposal.proposalDigest) !== undefined) throw new Error("effect already recorded");
        journal.db.prepare("UPDATE document SET body=?, applications=applications+1 WHERE id=1").run(input.body);
        journal.db.prepare("INSERT INTO effects(proposal_digest,body) VALUES (?,?)").run(proposal.proposalDigest, input.body);
      });
      options.afterEffect?.();
      return { body: input.body };
    },
    verify: ({ output, proposal }) => effect(proposal.proposalDigest)?.body === output.body
      ? { ok: true, evidence: { proposalDigest: proposal.proposalDigest, body: output.body } }
      : { ok: false, message: "exact effect ledger entry is absent or differs" },
    reconcile: ({ proposal }) => {
      const applied = effect(proposal.proposalDigest);
      return applied === undefined
        ? { status: "not-applied", reason: "no atomic effect ledger entry exists for this fenced attempt" }
        : { status: "completed", value: { body: applied.body } };
    },
  };
  const host: ControlHost<undefined> = {
    inspect: () => ({ installationId: target.installationId, installationDigest: target.installationDigest, programDigest: target.programDigest }),
    resolve: () => ({ target, hook, parseInput: body, parseOutput: body, parseState: body, parsePreview: body }),
  };
  return { read, capabilities: createControlCapabilities({ journal, clock: { now }, policy: allow,
    executor: { owner: options.owner ?? "worker" }, lease: { durationMs: 50 } }, host, scope) };
}
