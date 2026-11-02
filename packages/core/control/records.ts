import { isInteractionId, isSha256Digest, jsonEquals } from "@foxworth/boundary/program";
import { controlError } from "./errors";
import {
  isObject,
  recordSourceSnapshot,
  requiredString,
  requireExactFields,
} from "./record-snapshot";
import { CONTROL_RECORD_VERSION } from "./types";
import type {
  AttemptRef,
  UntypedAttemptRef,
  AttemptRecord,
  Grant,
  ProposalRecord,
  ReceiptRecord,
} from "./types";

export { snapshot } from "./record-snapshot";
export {
  CONTROL_PROPOSAL_DOMAIN,
  PUBLIC_PROPOSAL_SCHEMA,
  approvalMatchesProposal,
  grantMatchesProposal,
  normalizePublicProposal,
  publicHandleMatches,
  publicProposal,
  proposalDigest,
  requireValidProposal,
  snapshotApprovalRecords,
  verifyProposalIntegrity,
  type ProposalIntegrity,
} from "./proposal-records";

const ATTEMPT_RECORD_FIELDS = Object.freeze([
  "version",
  "id",
  "recordRevision",
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
  "execution",
  "verification",
  "lease",
  "createdAt",
  "updatedAt",
  "output",
  "evidence",
  "message",
] as const);
const ATTEMPT_RECORD_FIELD_SET = new Set<string>(ATTEMPT_RECORD_FIELDS);
const ATTEMPT_REQUIRED_FIELDS = Object.freeze([
  "version",
  "id",
  "recordRevision",
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
  "execution",
  "verification",
  "lease",
  "createdAt",
  "updatedAt",
] as const);

const RECEIPT_RECORD_FIELDS = Object.freeze([
  "version",
  "id",
  "attemptId",
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
  "output",
  "evidence",
  "completedAt",
] as const);
const RECEIPT_RECORD_FIELD_SET = new Set<string>(RECEIPT_RECORD_FIELDS);
const RECEIPT_REQUIRED_FIELDS = Object.freeze([
  "version",
  "id",
  "attemptId",
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
  "output",
  "completedAt",
] as const);

export function attemptMatches(
  attempt: AttemptRecord,
  proposal: ProposalRecord,
  grant: Grant,
): boolean {
  return (
    attempt.version === CONTROL_RECORD_VERSION &&
    requiredString(attempt.id) &&
    Number.isInteger(attempt.recordRevision) &&
    attempt.recordRevision > 0 &&
    attempt.proposalId === proposal.id &&
    attempt.proposalDigest === proposal.proposalDigest &&
    attempt.bindingDigest === proposal.bindingDigest &&
    attempt.projectionDigest === proposal.projectionDigest &&
    attempt.installationId === proposal.installationId &&
    attempt.installationDigest === proposal.installationDigest &&
    attempt.expectedProgramDigest === proposal.expectedProgramDigest &&
    attempt.actualProgramDigest === proposal.actualProgramDigest &&
    attempt.programDigest === proposal.programDigest &&
    attempt.programDigest === grant.programDigest &&
    attempt.grantId === grant.id &&
    attempt.controlDigest === proposal.controlDigest &&
    attempt.interactionId === proposal.interactionId &&
    attempt.expectedContractDigest === proposal.expectedContractDigest &&
    attempt.contractDigest === proposal.contractDigest &&
    attempt.requestRealizationId === proposal.requestRealizationId &&
    attempt.executionRealizationId === proposal.executionRealizationId &&
    attempt.controlRealizationDigest === proposal.controlRealizationDigest &&
    Number.isFinite(attempt.createdAt) &&
    Number.isFinite(attempt.updatedAt) &&
    requiredString(attempt.lease.owner) &&
    Number.isFinite(attempt.lease.expiresAt) &&
    Number.isInteger(attempt.lease.fence) &&
    attempt.lease.fence > 0
  );
}

function requireAttemptProjectionSource(value: AttemptRecord): AttemptRecord {
  const attempt = recordSourceSnapshot(value, "attempt");
  if (!isObject(attempt)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt",
      "attempt must be an object",
    );
  }
  if (attempt["version"] !== CONTROL_RECORD_VERSION) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.version",
      `attempt version must be ${CONTROL_RECORD_VERSION}`,
    );
  }
  requireExactFields(
    attempt,
    ATTEMPT_RECORD_FIELD_SET,
    ATTEMPT_REQUIRED_FIELDS,
    "attempt",
  );
  for (const field of [
    "id",
    "proposalId",
    "grantId",
    "installationId",
    "requestRealizationId",
    "executionRealizationId",
  ] as const) {
    if (!requiredString(attempt[field])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `attempt.${field}`,
        `attempt ${field} is required`,
      );
    }
  }
  for (const field of [
    "proposalDigest",
    "bindingDigest",
    "projectionDigest",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "programDigest",
    "controlDigest",
    "expectedContractDigest",
    "contractDigest",
    "controlRealizationDigest",
  ] as const) {
    if (!isSha256Digest(attempt[field])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `attempt.${field}`,
        `attempt ${field} is invalid`,
      );
    }
  }
  if (!isInteractionId(attempt["interactionId"])) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.interactionId",
      "attempt interactionId is invalid",
    );
  }
  if (
    !Number.isInteger(attempt["recordRevision"]) ||
    (attempt["recordRevision"] as number) <= 0
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.recordRevision",
      "attempt recordRevision must be a positive integer",
    );
  }
  if (
    attempt["execution"] !== "started" &&
    attempt["execution"] !== "uncertain" &&
    attempt["execution"] !== "not-applied" &&
    attempt["execution"] !== "completed"
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.execution",
      "attempt execution state is invalid",
    );
  }
  if (
    attempt["verification"] !== "pending" &&
    attempt["verification"] !== "verified" &&
    attempt["verification"] !== "failed"
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.verification",
      "attempt verification state is invalid",
    );
  }
  if (
    !Number.isFinite(attempt["createdAt"]) ||
    !Number.isFinite(attempt["updatedAt"])
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.updatedAt",
      "attempt timestamps must be finite",
    );
  }
  const lease = attempt["lease"];
  if (!isObject(lease)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.lease",
      "attempt lease must be an object",
    );
  }
  requireExactFields(
    lease,
    new Set(["owner", "expiresAt", "fence"]),
    ["owner", "expiresAt", "fence"],
    "attempt.lease",
  );
  if (
    !requiredString(lease["owner"]) ||
    !Number.isFinite(lease["expiresAt"]) ||
    !Number.isInteger(lease["fence"]) ||
    (lease["fence"] as number) <= 0
  ) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.lease",
      "attempt lease owner, expiration, and fence are invalid",
    );
  }
  if (attempt["message"] !== undefined && typeof attempt["message"] !== "string") {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "attempt.message",
      "attempt message must be a string",
    );
  }
  return attempt as AttemptRecord;
}

/** Snapshot and validate one complete durable attempt at a journal boundary. */
export function snapshotAttemptRecord(value: unknown): AttemptRecord {
  return requireAttemptProjectionSource(value as AttemptRecord);
}

/** Durable projection has no native output-type evidence. */
export function publicAttempt(attempt: AttemptRecord): AttemptRef {
  const source = requireAttemptProjectionSource(attempt);
  return Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id: source.id,
    proposalId: source.proposalId,
    bindingDigest: source.bindingDigest,
    projectionDigest: source.projectionDigest,
    installationId: source.installationId,
    installationDigest: source.installationDigest,
    expectedProgramDigest: source.expectedProgramDigest,
    actualProgramDigest: source.actualProgramDigest,
    programDigest: source.programDigest,
    interactionId: source.interactionId,
    expectedContractDigest: source.expectedContractDigest,
    contractDigest: source.contractDigest,
    requestRealizationId: source.requestRealizationId,
    executionRealizationId: source.executionRealizationId,
    controlRealizationDigest: source.controlRealizationDigest,
    controlDigest: source.controlDigest,
  }) as AttemptRef;
}

export function attemptRefMatches(
  reference: UntypedAttemptRef,
  attempt: AttemptRecord,
): boolean {
  return (
    reference.version === CONTROL_RECORD_VERSION &&
    reference.id === attempt.id &&
    reference.proposalId === attempt.proposalId &&
    reference.bindingDigest === attempt.bindingDigest &&
    reference.projectionDigest === attempt.projectionDigest &&
    reference.installationId === attempt.installationId &&
    reference.installationDigest === attempt.installationDigest &&
    reference.expectedProgramDigest === attempt.expectedProgramDigest &&
    reference.actualProgramDigest === attempt.actualProgramDigest &&
    reference.programDigest === attempt.programDigest &&
    reference.interactionId === attempt.interactionId &&
    reference.expectedContractDigest === attempt.expectedContractDigest &&
    reference.contractDigest === attempt.contractDigest &&
    reference.requestRealizationId === attempt.requestRealizationId &&
    reference.executionRealizationId === attempt.executionRealizationId &&
    reference.controlRealizationDigest === attempt.controlRealizationDigest &&
    reference.controlDigest === attempt.controlDigest
  );
}

export function receiptMatches(
  receipt: ReceiptRecord,
  attempt: AttemptRecord,
  proposal: ProposalRecord,
  grant: Grant,
): boolean {
  try {
    return (
      receipt.version === CONTROL_RECORD_VERSION &&
      requiredString(receipt.id) &&
      receipt.attemptId === attempt.id &&
      receipt.proposalId === proposal.id &&
      receipt.proposalDigest === proposal.proposalDigest &&
      receipt.bindingDigest === proposal.bindingDigest &&
      receipt.projectionDigest === proposal.projectionDigest &&
      receipt.installationId === proposal.installationId &&
      receipt.installationDigest === proposal.installationDigest &&
      receipt.expectedProgramDigest === proposal.expectedProgramDigest &&
      receipt.actualProgramDigest === proposal.actualProgramDigest &&
      receipt.programDigest === proposal.programDigest &&
      receipt.programDigest === attempt.programDigest &&
      receipt.programDigest === grant.programDigest &&
      receipt.grantId === grant.id &&
      receipt.controlDigest === proposal.controlDigest &&
      receipt.interactionId === proposal.interactionId &&
      receipt.expectedContractDigest === proposal.expectedContractDigest &&
      receipt.contractDigest === proposal.contractDigest &&
      receipt.requestRealizationId === proposal.requestRealizationId &&
      receipt.executionRealizationId === proposal.executionRealizationId &&
      receipt.controlRealizationDigest === proposal.controlRealizationDigest &&
      Number.isFinite(receipt.completedAt) &&
      attempt.execution === "completed" &&
      attempt.verification === "verified" &&
      attempt.output !== undefined &&
      jsonEquals(receipt.output, attempt.output) &&
      (attempt.evidence === undefined
        ? receipt.evidence === undefined
        : receipt.evidence !== undefined &&
          jsonEquals(receipt.evidence, attempt.evidence))
    );
  } catch {
    return false;
  }
}

/** Snapshot and validate one complete durable receipt at a journal boundary. */
export function snapshotReceiptRecord(
  value: unknown,
  path = "receipt",
): ReceiptRecord {
  const receipt = recordSourceSnapshot(value, path);
  if (!isObject(receipt)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      "receipt must be an object",
    );
  }
  requireExactFields(
    receipt,
    RECEIPT_RECORD_FIELD_SET,
    RECEIPT_REQUIRED_FIELDS,
    path,
  );
  if (receipt["version"] !== CONTROL_RECORD_VERSION) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.version`,
      `receipt version must be ${CONTROL_RECORD_VERSION}`,
    );
  }
  for (const field of [
    "id",
    "attemptId",
    "proposalId",
    "grantId",
    "installationId",
    "requestRealizationId",
    "executionRealizationId",
  ] as const) {
    if (!requiredString(receipt[field])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${path}.${field}`,
        `receipt ${field} is required`,
      );
    }
  }
  for (const field of [
    "proposalDigest",
    "bindingDigest",
    "projectionDigest",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "programDigest",
    "controlDigest",
    "expectedContractDigest",
    "contractDigest",
    "controlRealizationDigest",
  ] as const) {
    if (!isSha256Digest(receipt[field])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${path}.${field}`,
        `receipt ${field} is invalid`,
      );
    }
  }
  if (!isInteractionId(receipt["interactionId"])) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.interactionId`,
      "receipt interactionId is invalid",
    );
  }
  if (!Number.isFinite(receipt["completedAt"])) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.completedAt`,
      "receipt completedAt must be finite",
    );
  }
  return receipt as ReceiptRecord;
}
