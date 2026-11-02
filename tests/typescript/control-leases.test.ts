import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "../../packages/core/program/index";
import {
  MemoryJournal,
  TestClock,
  TestIds,
} from "../../packages/core/control/testing";
import type {
  Approval,
  AttemptRecord,
  Grant,
  ProposalRecord,
  ReceiptRecord,
} from "../../packages/core/control/types";

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const targetIdentity = Object.freeze({
  bindingDigest: digest("4"),
  projectionDigest: digest("5"),
  installationId: "installation:todos:1",
  installationDigest: digest("6"),
  expectedProgramDigest: digest("7"),
  actualProgramDigest: digest("7"),
  programDigest: digest("0"),
  controlDigest: digest("2"),
  interactionId: "todos.publish",
  expectedContractDigest: digest("8"),
  contractDigest: digest("3"),
  requestRealizationId: "realization:todos.publish:request:1",
  executionRealizationId: "realization:todos.publish:execute:1",
  controlRealizationDigest: digest("9"),
});

function proposal(
  id = "proposal-1",
  proposalDigest = digest("1"),
): ProposalRecord {
  return {
    version: 1,
    id,
    proposalDigest,
    ...targetIdentity,
    requestedBy: "author",
    subject: { kind: "todo-list", id: "inbox" },
    baselineSummary: "One unpublished todo",
    effects: [
      {
        kind: "network",
        action: "publish",
        resource: "todos/inbox",
        details: { count: 1 },
      },
    ],
    preview: { title: "Publish inbox" },
    createdAt: 1_000,
    input: { list: "inbox" },
    baseline: { revision: 7 },
    state: { body: ["Ship the journal"] },
  };
}

function approval(
  approvedBy = "reviewer-a",
  id = `approval-${approvedBy}`,
): Approval {
  return {
    version: 1,
    id,
    proposalId: "proposal-1",
    proposalDigest: digest("1"),
    ...targetIdentity,
    approvedBy,
    approvedAt: 1_010,
    preview: { title: "Publish inbox" },
  };
}

function grant(id = "grant-1", proposalDigest = digest("1")): Grant {
  return {
    version: 1,
    id,
    proposalId: "proposal-1",
    proposalDigest,
    ...targetIdentity,
    requestedBy: "author",
    approvedBy: ["reviewer-a"],
    subject: { kind: "todo-list", id: "inbox" },
    preview: { title: "Publish inbox" },
    issuedBy: "policy",
    issuedAt: 1_020,
  };
}

function attempt(
  changes: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    version: 1,
    id: "attempt-1",
    recordRevision: 1,
    proposalId: "proposal-1",
    proposalDigest: digest("1"),
    grantId: "grant-1",
    ...targetIdentity,
    execution: "started",
    verification: "pending",
    lease: { owner: "worker-a", expiresAt: 2_000, fence: 1 },
    createdAt: 1_030,
    updatedAt: 1_030,
    ...changes,
  };
}

function receipt(
  id = "receipt-1",
  proposalDigest = digest("1"),
): ReceiptRecord {
  return {
    version: 1,
    id,
    attemptId: "attempt-1",
    proposalId: "proposal-1",
    proposalDigest,
    grantId: "grant-1",
    ...targetIdentity,
    output: { published: true },
    evidence: { remoteRevision: 8 },
    completedAt: 1_100,
  };
}

describe("control testing primitives", () => {
  it("provides deterministic per-kind ids and a controllable finite clock", () => {
    const ids = new TestIds("fixture");
    expect(ids.nextId("proposal")).toBe("fixture-proposal-1");
    expect(ids.nextId("attempt")).toBe("fixture-attempt-1");
    expect(ids.nextId("proposal")).toBe("fixture-proposal-2");

    const clock = new TestClock(100);
    expect(clock.now()).toBe(100);
    expect(clock.advance(25)).toBe(125);
    expect(clock.set(500)).toBe(500);
    expect(clock.now()).toBe(500);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("takes deep snapshots on every journal boundary", async () => {
    const journal = new MemoryJournal();
    const source = proposal() as ProposalRecord & {
      state: { body: string[] };
    };
    const created = await journal.createProposal(source);
    source.state.body.push("Mutated after create");

    const firstRead = await journal.getProposal(source.id);
    const secondRead = await journal.getProposal(source.id);
    expect(created.kind).toBe("created");
    expect(firstRead?.state).toEqual({ body: ["Ship the journal"] });
    expect(firstRead).not.toBe(created.record);
    expect(secondRead).not.toBe(firstRead);
    expect(Object.isFrozen(firstRead)).toBe(true);
    expect(Object.isFrozen(firstRead?.state)).toBe(true);

    const records = [
      (await journal.createApproval(approval())).record,
      (await journal.createGrant(grant())).record,
      (await journal.createAttempt(attempt())).record,
      (await journal.createReceipt(receipt())).record,
    ];
    for (const record of records) expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(await journal.listApprovals(digest("1")))).toBe(true);
  });
});

describe("MemoryJournal create-if-absent laws", () => {
  it("atomically deduplicates proposal, grant, attempt, and receipt by proposal digest", async () => {
    const journal = new MemoryJournal();
    const cases = [
      Promise.all([
        journal.createProposal(proposal()),
        journal.createProposal(proposal("proposal-other")),
      ]),
      Promise.all([
        journal.createGrant(grant()),
        journal.createGrant(grant("grant-other")),
      ]),
      Promise.all([
        journal.createAttempt(attempt()),
        journal.createAttempt(attempt({ id: "attempt-other" })),
      ]),
      Promise.all([
        journal.createReceipt(receipt()),
        journal.createReceipt(receipt("receipt-other")),
      ]),
    ];

    for (const pending of cases) {
      const results = await pending;
      expect(results.map((entry) => entry.kind)).toEqual([
        "created",
        "existing",
      ]);
      expect(results[1]!.record.id).toBe(results[0]!.record.id);
    }
  });

  it("returns an existing approval only for the canonical-identical candidate", async () => {
    const journal = new MemoryJournal();
    const candidate = approval("reviewer-b", "approval-1");
    const [first, duplicate] = await Promise.all([
      journal.createApproval(candidate),
      journal.createApproval(candidate),
    ]);
    await expect(
      journal.createApproval(approval("reviewer-b", "approval-duplicate")),
    ).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
    await expect(
      journal.createApproval({ ...candidate, approvedAt: 1_011 }),
    ).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
    const otherActor = await journal.createApproval(
      approval("reviewer-a", "approval-2"),
    );

    expect(first.kind).toBe("created");
    expect(duplicate).toEqual({ kind: "existing", record: first.record });
    expect(otherActor.kind).toBe("created");
    expect(
      (await journal.listApprovals(digest("1"))).map(
        (entry) => entry.approvedBy,
      ),
    ).toEqual(["reviewer-a", "reviewer-b"]);
  });

  it("rejects id reuse for a different unique record", async () => {
    const journal = new MemoryJournal();
    await journal.createProposal(proposal());

    await expect(
      journal.createProposal(proposal("proposal-1", digest("9"))),
    ).rejects.toMatchObject({ code: "CONTROL_JOURNAL_CONFLICT" });
  });
});

describe("MemoryJournal attempt compare-and-swap laws", () => {
  it("advances exactly one revision and rejects stale writers without overwriting", async () => {
    const journal = new MemoryJournal();
    const initial = (await journal.createAttempt(attempt())).record;
    const renewed = attempt({
      recordRevision: 2,
      lease: { owner: "worker-a", expiresAt: 3_000, fence: 2 },
      updatedAt: 1_100,
    });

    expect(await journal.compareAndSwapAttempt(renewed, 1)).toBe(true);
    expect(await journal.compareAndSwapAttempt(initial, 1)).toBe(false);
    expect(await journal.getAttempt(initial.id)).toEqual(renewed);
  });

  it("fails loudly when the candidate skips or repeats a revision", async () => {
    const journal = new MemoryJournal();
    await journal.createAttempt(attempt());

    await expect(
      journal.compareAndSwapAttempt(attempt({ recordRevision: 3 }), 1),
    ).rejects.toMatchObject({
      code: "CONTROL_JOURNAL_CONFLICT",
      path: "attempt.recordRevision",
    });
    await expect(
      journal.compareAndSwapAttempt(attempt({ recordRevision: 1 }), 1),
    ).rejects.toMatchObject({
      code: "CONTROL_JOURNAL_CONFLICT",
      path: "attempt.recordRevision",
    });
    expect((await journal.getAttempt("attempt-1"))?.recordRevision).toBe(1);
  });

  it.each([
    ["proposalId", "proposal-other"],
    ["proposalDigest", digest("8")],
    ["bindingDigest", digest("8")],
    ["projectionDigest", digest("8")],
    ["installationId", "installation:todos:other"],
    ["installationDigest", digest("8")],
    ["expectedProgramDigest", digest("8")],
    ["actualProgramDigest", digest("8")],
    ["programDigest", digest("8")],
    ["grantId", "grant-other"],
    ["controlDigest", digest("7")],
    ["interactionId", "todos.delete"],
    ["expectedContractDigest", digest("6")],
    ["contractDigest", digest("6")],
    ["requestRealizationId", "realization:todos.delete:request:1"],
    ["executionRealizationId", "realization:todos.delete:execute:1"],
    ["controlRealizationDigest", digest("6")],
    ["createdAt", 999],
  ] as const)("preserves immutable attempt identity field %s", async (field, value) => {
    const journal = new MemoryJournal();
    await journal.createAttempt(attempt());
    const candidate = attempt({
      recordRevision: 2,
      [field]: value,
    });

    await expect(
      journal.compareAndSwapAttempt(candidate, 1),
    ).rejects.toMatchObject({
      code: "CONTROL_JOURNAL_CONFLICT",
      path: `attempt.${field}`,
    });
    expect((await journal.getAttempt("attempt-1"))?.recordRevision).toBe(1);
  });

  it("cannot move an attempt to a new id", async () => {
    const journal = new MemoryJournal();
    await journal.createAttempt(attempt());

    expect(
      await journal.compareAndSwapAttempt(
        attempt({ id: "attempt-other", recordRevision: 2 }),
        1,
      ),
    ).toBe(false);
    expect(await journal.getAttempt("attempt-other")).toBeUndefined();
  });
});
