import { afterEach, describe, expect, it } from "vitest";
import { createControlReader, proposalDigest, type ControlJournal } from "../../../packages/core/control/index";
import { validProposal, descendants } from "./controlJournalRecords";

export interface JournalFixture {
  journal: ControlJournal;
  reopen(): ControlJournal;
  cleanup(): void;
}

/** The same observable storage laws qualify each factory, independently of encoding. */
export function journalLaws(name: string, factory: () => JournalFixture) {
  describe(name, () => {
    let fixture: JournalFixture;
    afterEach(() => fixture?.cleanup());
    it("owns snapshots, suppresses duplicate creates, rejects id collisions, and retains records on reopen", async () => {
      fixture = factory();
      const proposal = await validProposal();
      const { approval, grant, attempt, receipt } = descendants(proposal);
      const first = await fixture.journal.createProposal(proposal);
      expect(Object.isFrozen(first.record.input)).toBe(true);
      expect(await fixture.journal.createProposal({ ...proposal, id: "another" })).toEqual({ kind: "existing", record: first.record });
      await expect(fixture.journal.createProposal({ ...proposal, proposalDigest: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
      await fixture.journal.createApproval(approval);
      await expect(fixture.journal.createApproval({ ...approval, preview: null })).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
      await fixture.journal.createGrant(grant);
      await fixture.journal.createAttempt(attempt);
      await fixture.journal.createReceipt(receipt);
      const reopened = fixture.reopen();
      expect(await reopened.getProposal(proposal.id)).toEqual(proposal);
      expect(await reopened.listApprovals(proposal.proposalDigest)).toEqual([approval]);
      expect(await reopened.findGrantByProposalDigest(proposal.proposalDigest)).toEqual(grant);
      expect(await reopened.findAttemptByProposalDigest(proposal.proposalDigest)).toEqual(attempt);
      expect(await reopened.findReceiptByProposalDigest(proposal.proposalDigest)).toEqual(receipt);
    });
    it("allows one CAS winner, rejects stale and immutable updates", async () => {
      fixture = factory();
      const { attempt } = descendants(await validProposal());
      await fixture.journal.createAttempt(attempt);
      const second = fixture.reopen();
      const candidate = { ...attempt, recordRevision: attempt.recordRevision + 1 };
      const winners = await Promise.all([second.compareAndSwapAttempt(candidate, attempt.recordRevision), second.compareAndSwapAttempt(candidate, attempt.recordRevision)]);
      expect(winners.sort()).toEqual([false, true]);
      await expect(second.compareAndSwapAttempt({ ...candidate, recordRevision: candidate.recordRevision + 1, grantId: "other" }, candidate.recordRevision)).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
    });
    it("paginates scoped proposals with batch reads and excludes private fields", async () => {
      fixture = factory();
      const base = await validProposal();
      for (const [id, tenant] of [["a", "inbox"], ["b", "elsewhere"], ["c", "inbox"], ["é", "inbox"]]) {
        const { proposalDigest: _digest, ...identity } = base;
        const raw = { ...identity, id, subject: { kind: "todo-list", id: tenant } };
        await fixture.journal.createProposal({ ...raw, proposalDigest: proposalDigest(raw) });
      }
      const reader = createControlReader({ journal: fixture.journal }, { interactionIds: [base.interactionId], tenant: base.subject });
      const first = await reader.page({ limit: 2 });
      expect(first.items.map((row) => row.proposal.id)).toEqual(["a", "c"]);
      expect(first.nextAfterId).toBe("c");
      expect(first.items[0].proposal).not.toHaveProperty("state");
      const second = await reader.page({ limit: 2, afterId: first.nextAfterId });
      expect(second.items.map((row) => row.proposal.id)).toEqual(["é"]);
      expect(second.nextAfterId).toBeUndefined();
      expect([...first.items, ...second.items]).toEqual(await reader.list());
      await expect(reader.page({ limit: 101 })).rejects.toMatchObject({ code: "CONTROL_INVALID_RECORD" });
    });
  });
}
