import type { Sha256Digest } from "../../../packages/core/program/index";
import { proposalDigest, type Approval, type AttemptRecord, type Grant, type ProposalRecord, type ReceiptRecord } from "../../../packages/core/control/index";

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

export async function validProposal(): Promise<ProposalRecord> {
  const identity = proposalIdentity();
  return {
    ...identity,
    proposalDigest: proposalDigest(identity),
  };
}

export function descendants(proposal: ProposalRecord) {
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
