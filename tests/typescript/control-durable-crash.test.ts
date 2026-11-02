import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { SqliteJournal } from "../../examples/concepts/typescript/control-durable/sqliteJournal";
import { documentHost, target } from "../../examples/concepts/typescript/control-durable/documentHost";
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");

describe("SQLite process-death recovery", () => {
  it.each(["attempt", "effect", "receipt"])("survives SIGKILL after %s commit", async (boundary) => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-crash-"));
    const path = join(dir, "journal.sqlite");
    let journal = new SqliteJournal(path);
    try {
      const initial = documentHost(journal, () => 100);
      const proposal = await initial.capabilities.requester.request({ actor: "requester", target, context: undefined, input: { body: "after" } });
      await initial.capabilities.admin.approve(proposal, "approver");
      const grant = await initial.capabilities.admin.grant(proposal, "owner");
      journal.close();
      const child = spawnSync(process.execPath, ["--import", loader, resolve("tests/typescript/helpers/controlCrashChild.ts"), path, boundary, grant.id], { encoding: "utf8", timeout: 15000 });
      // SIGKILL proves the configured boundary fired; a thrown/uncaught error does not qualify.
      expect(child.signal, child.stderr).toBe("SIGKILL");
      journal = new SqliteJournal(path);
      const recovered = documentHost(journal, () => 200, { owner: "recovery-worker" });
      const before = await recovered.capabilities.admin.execute(grant, "executor", undefined);
      expect(before.status).toBe(boundary === "receipt" ? "completed" : "uncertain");
      expect(recovered.read().applications).toBe(boundary === "attempt" ? 0 : 1);
      const attempt = await journal.findAttemptByProposalDigest(proposal.proposalDigest);
      expect(attempt).toBeDefined();
      const result = await recovered.capabilities.admin.reconcile(attempt!.id, "executor", undefined);
      expect(result.status).toBe(boundary === "attempt" ? "not-applied" : "completed");
      await recovered.capabilities.admin.execute(grant, "executor", undefined);
      expect(recovered.read().applications).toBe(boundary === "attempt" ? 0 : 1);
      if (boundary === "receipt") {
        expect(await journal.findReceiptByProposalDigest(proposal.proposalDigest)).toEqual((before as { receipt: unknown }).receipt);
      }
    } finally { try { journal.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
  });

  it("fences a suspended executor after a second connection claims reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-fence-"));
    const path = join(dir, "journal.sqlite");
    const first = new SqliteJournal(path);
    const second = new SqliteJournal(path);
    let now = 100;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      const a = documentHost(first, () => now, { owner: "a", beforeEffect: async () => { entered(); await barrier; } });
      const b = documentHost(second, () => now, { owner: "b" });
      const proposal = await a.capabilities.requester.request({ actor: "requester", target, context: undefined, input: { body: "after" } });
      await a.capabilities.admin.approve(proposal, "approver");
      const grant = await a.capabilities.admin.grant(proposal, "owner");
      const executing = a.capabilities.admin.execute(grant, "executor", undefined);
      await ready;
      expect((await b.capabilities.admin.execute(grant, "executor", undefined)).status).toBe("uncertain");
      now = 200;
      const attempt = await second.findAttemptByProposalDigest(proposal.proposalDigest);
      expect((await b.capabilities.admin.reconcile(attempt!.id, "executor", undefined)).status).toBe("not-applied");
      release();
      await executing;
      expect(b.read().applications).toBe(0);
      expect((await second.getAttempt(attempt!.id))!.lease.fence).toBe(2);
    } finally { release?.(); first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// The same reviewed outcomes run against TS's native records and SQLite host adapter.
import recoveryEvidence from "../conformance/v1/control-recovery.json";
it.each(recoveryEvidence.cases)("reviewed native recovery trace: $id", async (trace) => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-trace-"));
  const journal = new SqliteJournal(join(dir, "journal.sqlite"));
  let now = 100;
  try {
    const host = documentHost(journal, () => now, { afterEffect() {
      if (trace.loseEffectResponse) throw new Error("effect response lost");
    } });
    const { capabilities } = host;
    const proposal = await capabilities.requester.request({ actor: "requester", target, context: undefined, input: { body: "after" } });
    await capabilities.admin.approve(proposal, "approver");
    const grant = await capabilities.admin.grant(proposal, "owner");
    const initial = await capabilities.admin.execute(grant, "executor", undefined);
    expect(initial.status).toBe(trace.initial);
    expect((await capabilities.admin.execute(grant, "executor", undefined)).status).toBe(trace.replay);
    now = 151;
    const recovered = initial.status === "uncertain" ? await capabilities.admin.reconcile(initial.attempt, "executor", undefined) : initial;
    expect(recovered.status).toBe(trace.afterLeaseExpiry);
    expect(host.read().applications).toBe(trace.applyCalls);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  { applied: true, intervening: "different", expected: "completed" },
  { applied: true, intervening: "after", expected: "completed" },
  { applied: false, intervening: "after", expected: "not-applied" },
])("reconciles exact effect evidence despite another writer: $applied/$intervening", async ({ applied, intervening, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-ledger-"));
  const journal = new SqliteJournal(join(dir, "journal.sqlite"));
  let now = 100;
  try {
    const host = documentHost(journal, () => now, {
      async beforeEffect() { if (!applied) throw new Error("effect not reached"); },
      afterEffect() { throw new Error("effect acknowledgment lost"); },
    });
    const { capabilities } = host;
    const proposal = await capabilities.requester.request({ actor: "requester", target, context: undefined, input: { body: "after" } });
    await capabilities.admin.approve(proposal, "approver");
    const grant = await capabilities.admin.grant(proposal, "owner");
    const initial = await capabilities.admin.execute(grant, "executor", undefined);
    expect(initial.status).toBe("uncertain");
    if (initial.status !== "uncertain") throw new Error("uncertainty expected");
    journal.db.prepare("UPDATE document SET body=? WHERE id=1").run(intervening);
    now = 151;
    const outcome = await capabilities.admin.reconcile(initial.attempt, "executor", undefined);
    expect(outcome.status).toBe(expected);
    if (outcome.status === "completed") expect(outcome.value).toEqual({ body: "after" });
    expect(host.read().body).toBe(intervening);
    expect(host.read().applications).toBe(applied ? 1 : 0);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
