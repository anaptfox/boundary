import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "../../packages/core/control/testing";
import { SqliteJournal } from "../../examples/concepts/typescript/control-durable/sqliteJournal";
import { createControlReader, proposalDigest, type ProposalRecord } from "../../packages/core/control/index";
import { descendants, validProposal } from "./helpers/controlJournalRecords";

import { journalLaws } from "./helpers/controlJournalLaws";

journalLaws("MemoryJournal laws (same-process reopen)", () => {
  const journal = new MemoryJournal();
  return { journal, reopen: () => journal, cleanup() {} };
});
journalLaws("SQLite journal laws (close and reopen)", () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-sqlite-laws-"));
  const path = join(dir, "journal.sqlite");
  let journal = new SqliteJournal(path);
  return { journal, reopen() { journal.close(); journal = new SqliteJournal(path); return journal; },
    cleanup() { journal.close(); rmSync(dir, { recursive: true, force: true }); } };
});

describe("reader distrusts query adapters", () => {
  it("uses direct lookup and refuses substituted keys, scopes, ordering and chains", async () => {
    const base = await validProposal();
    class Counting extends MemoryJournal {
      lists = 0;
      gets = 0;
      override async listProposals() { this.lists++; return super.listProposals(); }
      override async getProposal(id: string) { this.gets++; return super.getProposal(id); }
    }
    const journal = new Counting();
    await journal.createProposal(base);
    const reader = createControlReader({ journal }, { interactionIds: [base.interactionId], tenant: base.subject });
    expect(await reader.list({ proposalId: base.id })).toHaveLength(1);
    expect(journal.lists).toBe(0);
    expect(journal.gets).toBe(1);
    journal.queryProposals = async () => [{ ...base, subject: { ...base.subject, id: "other" } }];
    await expect(reader.page({ limit: 1 })).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
    journal.queryProposals = async () => [base, base];
    await expect(reader.page({ limit: 2 })).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
    journal.queryProposals = async () => [base];
    journal.readStatusChains = async () => [{ proposalDigest: `sha256:${"0".repeat(64)}` }];
    await expect(reader.page({ limit: 1 })).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
  });
});

it("snapshots exact page queries before awaiting storage", async () => {
  const proposal = await validProposal();
  const journal = new MemoryJournal();
  await journal.createProposal(proposal);
  const reader = createControlReader({ journal }, { interactionIds: [proposal.interactionId], tenant: proposal.subject });
  const query = { limit: 1 };
  const nativeQuery = journal.queryProposals.bind(journal);
  journal.queryProposals = async (owned) => {
    query.limit = 0;
    return nativeQuery(owned);
  };
  expect((await reader.page(query)).items).toHaveLength(1);
  await expect(reader.page({ limit: 1, extra: true } as never)).rejects.toMatchObject({ code: "CONTROL_INVALID_RECORD" });
  let accessed = false;
  await expect(reader.page({ get limit() { accessed = true; return 1; } })).rejects.toMatchObject({ code: "CONTROL_INVALID_RECORD" });
  expect(accessed).toBe(false);
});

async function populatedJournal(count: number) {
  const base = await validProposal();
  const journal = new MemoryJournal();
  const { proposalDigest: _digest, ...identity } = base;
  const proposals: ProposalRecord[] = [];
  for (let index = 0; index < count; index++) {
    const raw = { ...identity, id: `proposal-${String(index).padStart(2, "0")}` };
    const proposal = { ...raw, proposalDigest: proposalDigest(raw) };
    proposals.push(proposal);
    await journal.createProposal(proposal);
    const records = descendants(proposal);
    const grant = { ...records.grant, id: `grant-${index}` };
    const attempt = { ...records.attempt, id: `attempt-${index}`, grantId: grant.id };
    const receipt = { ...records.receipt, id: `receipt-${index}`, grantId: grant.id, attemptId: attempt.id };
    await journal.createGrant(grant);
    await journal.createAttempt(attempt);
    await journal.createReceipt(receipt);
  }
  const reader = createControlReader({ journal }, { interactionIds: [base.interactionId], tenant: base.subject });
  return { journal, reader, proposals };
}

it("uses bounded list batches with the same ordered public statuses as the concurrent fallback", async () => {
  const { journal, reader, proposals } = await populatedJournal(35);
  let queries = 0;
  const query = journal.queryProposals.bind(journal);
  const batch = journal.readStatusChains.bind(journal);
  const batches: number[] = [];
  journal.queryProposals = async (args) => { queries++; expect(args.limit).toBe(6); return query(args); };
  journal.readStatusChains = async (digests) => { batches.push(digests.length); return batch(digests); };
  const find = journal.findGrantByProposalDigest.bind(journal);
  const findAttempt = journal.findAttemptByProposalDigest.bind(journal);
  const findReceipt = journal.findReceiptByProposalDigest.bind(journal);
  let active = 0;
  let maximum = 0;
  const lookups = { grant: 0, attempt: 0, receipt: 0 };
  journal.findGrantByProposalDigest = async (digest) => {
    lookups.grant++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--; return find(digest);
  };
  journal.findAttemptByProposalDigest = async (digest) => { lookups.attempt++; return findAttempt(digest); };
  journal.findReceiptByProposalDigest = async (digest) => { lookups.receipt++; return findReceipt(digest); };
  expect((await reader.page({ limit: 5 })).items).toHaveLength(5);
  expect(queries).toBe(1);
  expect(batches).toEqual([5]);
  expect(lookups).toEqual({ grant: 0, attempt: 0, receipt: 0 });
  const batched = await reader.list();
  expect(batched.map((status) => status.proposal.id)).toEqual(proposals.map((proposal) => proposal.id));
  expect(batched.every((status) => status.grant && status.attempt && status.receipt)).toBe(true);
  expect(batched[0]!.proposal).not.toHaveProperty("state");
  expect(Object.isFrozen(batched)).toBe(true);
  expect(batches).toEqual([5, 16, 16, 3]);
  expect(lookups).toEqual({ grant: 0, attempt: 0, receipt: 0 });
  Object.defineProperty(journal, "readStatusChains", { value: undefined, configurable: true });
  expect(await reader.list()).toEqual(batched);
  expect(lookups).toEqual({ grant: 35, attempt: 35, receipt: 35 });
  expect(maximum).toBeLessThanOrEqual(16);
  expect(batches).toEqual([5, 16, 16, 3]);
});

describe("list batch integrity", () => {
  it.each(["missing", "extra", "reordered", "substituted", "null", "sparse", "not-array"] as const)(
    "rejects %s chains instead of returning partial or substituted status",
    async (corruption) => {
      const { journal, reader } = await populatedJournal(2);
      const nativeBatch = journal.readStatusChains.bind(journal);
      journal.readStatusChains = async (digests) => {
        const chains = await nativeBatch(digests);
        switch (corruption) {
          case "missing": return chains.slice(0, -1);
          case "extra": return [...chains, chains[0]!];
          case "reordered": return [...chains].reverse();
          case "substituted": return [{ ...chains[0]!, proposalDigest: chains[1]!.proposalDigest }, chains[1]!];
          case "null": return [null as never, chains[1]!];
          case "sparse": return new Array(chains.length);
          case "not-array": return {} as never;
        }
      };
      await expect(reader.list()).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
    },
  );

  it.each(["grant", "attempt", "receipt"] as const)("rechecks exact %s identity from batches", async (kind) => {
    const { journal, reader } = await populatedJournal(1);
    const nativeBatch = journal.readStatusChains.bind(journal);
    journal.readStatusChains = async (digests) => {
      const [chain] = await nativeBatch(digests);
      return [{ ...chain!, [kind]: { ...chain![kind]!, interactionId: "todos.other" } }];
    };
    await expect(reader.list()).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
  });

  it("scope-filters and validates proposals before batch reads", async () => {
    const { journal, reader, proposals: [base] } = await populatedJournal(1);
    const { proposalDigest: _digest, ...identity } = base!;
    const otherTenant = { ...identity, id: "other-tenant", subject: { ...identity.subject, id: "elsewhere" } };
    const otherInteraction = { ...identity, id: "other-interaction", interactionId: "todos.other" };
    await journal.createProposal({ ...otherTenant, proposalDigest: proposalDigest(otherTenant) });
    await journal.createProposal({ ...otherInteraction, proposalDigest: proposalDigest(otherInteraction) });
    const nativeBatch = journal.readStatusChains.bind(journal);
    const requested: string[][] = [];
    journal.readStatusChains = async (digests) => { requested.push([...digests]); return nativeBatch(digests); };
    expect(await reader.list()).toHaveLength(1);
    expect(requested).toEqual([[base!.proposalDigest]]);
    requested.length = 0;
    expect(await reader.list({ interactionId: otherInteraction.interactionId })).toEqual([]);
    expect(await reader.list({ proposalId: otherTenant.id })).toEqual([]);
    expect(requested).toEqual([]);
    expect(await reader.list({ proposalId: base!.id })).toHaveLength(1);
    expect(requested).toEqual([[base!.proposalDigest]]);
    requested.length = 0;
    journal.listProposals = async () => [{ ...base!, proposalDigest: `sha256:${"0".repeat(64)}` }];
    await expect(reader.list()).rejects.toMatchObject({ code: "CONTROL_INTEGRITY_MISMATCH" });
    expect(requested).toEqual([]);
  });
});
