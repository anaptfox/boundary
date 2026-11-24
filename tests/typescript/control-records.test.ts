import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "../../packages/core/program/index";
import {
  CONTROL_PROPOSAL_DOMAIN,
  publicAttempt,
  publicProposal,
  proposalDigest,
  verifyProposalIntegrity,
  type Approval,
  type AttemptRecord,
  type Grant,
  type Proposal,
  type ProposalRecord,
  type ReceiptRecord,
} from "../../packages/core/control/index";
import {
  approvalMatchesProposal,
  attemptMatches,
  attemptRefMatches,
  grantMatchesProposal,
  publicHandleMatches,
  receiptMatches,
} from "../../packages/core/control/records";

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const targetIdentity = Object.freeze({
  bindingDigest: digest("d"),
  projectionDigest: digest("e"),
  installationId: "installation:todos:7",
  installationDigest: digest("f"),
  expectedProgramDigest: digest("9"),
  actualProgramDigest: digest("9"),
  programDigest: digest("a"),
  controlDigest: digest("b"),
  interactionId: "todos.publish",
  expectedContractDigest: digest("8"),
  contractDigest: digest("c"),
  requestRealizationId: "realization:todos.publish:request:7",
  executionRealizationId: "realization:todos.publish:execute:7",
  controlRealizationDigest: digest("7"),
});

function recordIdentity(proposal: ProposalRecord) {
  return {
    bindingDigest: proposal.bindingDigest,
    projectionDigest: proposal.projectionDigest,
    installationId: proposal.installationId,
    installationDigest: proposal.installationDigest,
    expectedProgramDigest: proposal.expectedProgramDigest,
    actualProgramDigest: proposal.actualProgramDigest,
    programDigest: proposal.programDigest,
    controlDigest: proposal.controlDigest,
    interactionId: proposal.interactionId,
    expectedContractDigest: proposal.expectedContractDigest,
    contractDigest: proposal.contractDigest,
    requestRealizationId: proposal.requestRealizationId,
    executionRealizationId: proposal.executionRealizationId,
    controlRealizationDigest: proposal.controlRealizationDigest,
  };
}

function proposalIdentity(): Omit<ProposalRecord, "proposalDigest"> {
  return {
    version: 1,
    id: "proposal-7",
    ...targetIdentity,
    requestedBy: "author-1",
    input: { list: "inbox", limit: 2 },
    subject: { kind: "todo-list", id: "inbox" },
    baseline: { revision: 7 },
    baselineSummary: "revision 7",
    effects: [
      {
        kind: "network",
        action: "publish",
        resource: "todos/inbox",
        description: "Publish two todos",
        details: { count: 2 },
      },
    ],
    state: { todoIds: ["todo-1", "todo-2"] },
    preview: { title: "Publish inbox", count: 2 },
    createdAt: 1_000,
  };
}

async function validProposal(): Promise<ProposalRecord> {
  const identity = proposalIdentity();
  return {
    ...identity,
    proposalDigest: proposalDigest(identity),
  };
}

function descendants(proposal: ProposalRecord) {
  const approval: Approval = {
    version: 1,
    id: "approval-1",
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    ...recordIdentity(proposal),
    approvedBy: "reviewer-1",
    approvedAt: 1_010,
    preview: proposal.preview,
  };
  const grant: Grant = {
    version: 1,
    id: "grant-1",
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    ...recordIdentity(proposal),
    requestedBy: proposal.requestedBy,
    approvedBy: [approval.approvedBy],
    subject: proposal.subject,
    preview: proposal.preview,
    issuedBy: "policy-1",
    issuedAt: 1_020,
  };
  const attempt: AttemptRecord = {
    version: 1,
    id: "attempt-1",
    recordRevision: 3,
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    grantId: grant.id,
    ...recordIdentity(proposal),
    execution: "completed",
    verification: "verified",
    lease: { owner: "worker-1", expiresAt: 2_000, fence: 1 },
    createdAt: 1_030,
    updatedAt: 1_040,
    output: { published: true },
    evidence: { revision: 8 },
  };
  const receipt: ReceiptRecord = {
    version: 1,
    id: "receipt-1",
    attemptId: attempt.id,
    proposalId: proposal.id,
    proposalDigest: proposal.proposalDigest,
    grantId: grant.id,
    ...recordIdentity(proposal),
    output: attempt.output!,
    evidence: attempt.evidence,
    completedAt: 1_050,
  };
  return { approval, grant, attempt, receipt };
}

describe("control record identity", () => {
  it("has an independent golden digest for a complete proposal", async () => {
    expect(CONTROL_PROPOSAL_DOMAIN).toBe("boundary.control-proposal/v1");
    expect(proposalDigest(proposalIdentity())).toBe(
      "sha256:afde4671c0499dcae6396fa2401e3dcc43864f86b888be6e461874d6db8852dd",
    );
  });

  it.each([
    ["bindingDigest", digest("0")],
    ["projectionDigest", digest("0")],
    ["installationId", "installation:todos:other"],
    ["installationDigest", digest("0")],
    ["expectedProgramDigest", digest("0")],
    ["actualProgramDigest", digest("0")],
    ["programDigest", digest("d")],
    ["controlDigest", digest("d")],
    ["expectedContractDigest", digest("0")],
    ["contractDigest", digest("d")],
    ["interactionId", "todos.delete"],
    ["requestRealizationId", "realization:todos.delete:request:7"],
    ["executionRealizationId", "realization:todos.delete:execute:7"],
    ["controlRealizationDigest", digest("0")],
    ["requestedBy", "attacker"],
    ["input", { list: "other", limit: 2 }],
    ["baseline", { revision: 8 }],
    ["state", { todoIds: ["todo-3"] }],
    ["preview", { title: "Delete inbox", count: 2 }],
  ] as const)("rejects proposal %s tampering", async (field, value) => {
    const proposal = await validProposal();
    const integrity = verifyProposalIntegrity({
      ...proposal,
      [field]: value,
    } as ProposalRecord);

    expect(integrity).toEqual({
      status: "invalid",
      reason: "proposal digest does not match its content",
    });
  });

  it("fails closed on the unknown-version proposal record", async () => {
    const proposal = await validProposal();
    const integrity = verifyProposalIntegrity({
      ...proposal,
      version: 99,
    } as unknown as ProposalRecord);

    expect(integrity).toEqual({
      status: "invalid",
      reason: "proposal version must be 1",
    });
  });

  it("fails closed on every unknown-version public and durable descendant", async () => {
    const proposal = await validProposal();
    const { approval, grant, attempt, receipt } = descendants(proposal);
    const handle = publicProposal(proposal);
    const attemptRef = publicAttempt(attempt);

    expect([
      publicHandleMatches(
        { ...handle, version: 99 } as unknown as Proposal,
        proposal,
      ),
      approvalMatchesProposal(
        { ...approval, version: 99 } as unknown as Approval,
        proposal,
      ),
      grantMatchesProposal(
        { ...grant, version: 99 } as unknown as Grant,
        proposal,
      ),
      attemptMatches(
        { ...attempt, version: 99 } as unknown as AttemptRecord,
        proposal,
        grant,
      ),
      attemptRefMatches(
        { ...attemptRef, version: 99 } as unknown as typeof attemptRef,
        attempt,
      ),
      receiptMatches(
        { ...receipt, version: 99 } as unknown as ReceiptRecord,
        attempt,
        proposal,
        grant,
      ),
    ]).toEqual([false, false, false, false, false, false]);
  });

  it("rejects unknown-version records at the public projection source", async () => {
    const proposal = await validProposal();
    const { attempt } = descendants(proposal);

    expect(() =>
      publicProposal({
        ...proposal,
        version: 99,
      } as unknown as ProposalRecord),
    ).toThrowError(expect.objectContaining({
      code: "CONTROL_INVALID_RECORD",
      path: "proposal.version",
    }));
    expect(() =>
      publicAttempt({
        ...attempt,
        version: 99,
      } as unknown as AttemptRecord),
    ).toThrowError(expect.objectContaining({
      code: "CONTROL_INVALID_RECORD",
      path: "attempt.version",
    }));
  });

  it("rejects unexpected authority fields instead of silently projecting them away", async () => {
    const proposal = await validProposal();
    const { attempt } = descendants(proposal);

    expect(() =>
      publicProposal({
        ...proposal,
        privateAuthority: "forged",
      } as ProposalRecord),
    ).toThrowError(expect.objectContaining({
      code: "CONTROL_INVALID_RECORD",
    }));
    expect(() =>
      publicAttempt({
        ...attempt,
        privateAuthority: "forged",
      } as AttemptRecord),
    ).toThrowError(expect.objectContaining({
      code: "CONTROL_INVALID_RECORD",
    }));
  });

  it("rejects a changed Program pin throughout the authority chain", async () => {
    const proposal = await validProposal();
    const { approval, grant, attempt, receipt } = descendants(proposal);
    const otherProgram = digest("d");
    const attemptRef = publicAttempt(attempt);

    expect([
      publicHandleMatches(
        { ...publicProposal(proposal), programDigest: otherProgram },
        proposal,
      ),
      approvalMatchesProposal(
        { ...approval, programDigest: otherProgram },
        proposal,
      ),
      grantMatchesProposal(
        { ...grant, programDigest: otherProgram },
        proposal,
      ),
      attemptMatches(
        { ...attempt, programDigest: otherProgram },
        proposal,
        grant,
      ),
      attemptMatches(
        attempt,
        proposal,
        { ...grant, programDigest: otherProgram },
      ),
      attemptRefMatches(
        { ...attemptRef, programDigest: otherProgram },
        attempt,
      ),
      receiptMatches(
        { ...receipt, programDigest: otherProgram },
        attempt,
        proposal,
        grant,
      ),
      receiptMatches(
        receipt,
        { ...attempt, programDigest: otherProgram },
        proposal,
        grant,
      ),
      receiptMatches(
        receipt,
        attempt,
        proposal,
        { ...grant, programDigest: otherProgram },
      ),
    ]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
