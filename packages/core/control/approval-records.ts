import {
  isInteractionId,
  isSha256Digest,
  jsonEquals,
  type JsonValue,
} from "@foxworth/boundary/program";
import { controlError } from "./errors";
import {
  isObject,
  projectionSourceSnapshot,
  requiredString,
  requireExactFields,
} from "./record-snapshot";
import { CONTROL_RECORD_VERSION } from "./types";
import type { Approval, ProposalRecord } from "./types";

const APPROVAL_RECORD_FIELDS = Object.freeze([
  "version",
  "id",
  "proposalId",
  "proposalDigest",
  "bindingDigest",
  "projectionDigest",
  "installationId",
  "installationDigest",
  "expectedProgramDigest",
  "actualProgramDigest",
  "programDigest",
  "controlDigest",
  "interactionId",
  "expectedContractDigest",
  "contractDigest",
  "requestRealizationId",
  "executionRealizationId",
  "controlRealizationDigest",
  "approvedBy",
  "approvedAt",
  "preview",
] as const);
const APPROVAL_RECORD_FIELD_SET = new Set<string>(APPROVAL_RECORD_FIELDS);

export function approvalMatchesProposal(
  approval: Approval,
  proposal: ProposalRecord,
): boolean {
  return (
    approval.version === CONTROL_RECORD_VERSION &&
    requiredString(approval.id) &&
    approval.proposalId === proposal.id &&
    approval.proposalDigest === proposal.proposalDigest &&
    approval.bindingDigest === proposal.bindingDigest &&
    approval.projectionDigest === proposal.projectionDigest &&
    approval.installationId === proposal.installationId &&
    approval.installationDigest === proposal.installationDigest &&
    approval.expectedProgramDigest === proposal.expectedProgramDigest &&
    approval.actualProgramDigest === proposal.actualProgramDigest &&
    approval.programDigest === proposal.programDigest &&
    approval.controlDigest === proposal.controlDigest &&
    approval.interactionId === proposal.interactionId &&
    approval.expectedContractDigest === proposal.expectedContractDigest &&
    approval.contractDigest === proposal.contractDigest &&
    approval.requestRealizationId === proposal.requestRealizationId &&
    approval.executionRealizationId === proposal.executionRealizationId &&
    approval.controlRealizationDigest === proposal.controlRealizationDigest &&
    requiredString(approval.approvedBy) &&
    Number.isFinite(approval.approvedAt) &&
    jsonEquals(
      approval.preview as unknown as JsonValue,
      proposal.preview as unknown as JsonValue,
    )
  );
}

/** Snapshot and validate the complete durable approval list at a journal boundary. */
export function snapshotApprovalRecords(
  value: unknown,
  path: string,
): readonly Approval[] {
  const approvals = projectionSourceSnapshot(value, path);
  if (!Array.isArray(approvals)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      "approval list must be an array",
    );
  }
  const approvalIds = new Set<string>();
  const approvingActors = new Set<string>();
  for (let index = 0; index < approvals.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const approval = approvals[index];
    if (!isObject(approval)) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        itemPath,
        "approval must be an object",
      );
    }
    requireExactFields(
      approval,
      APPROVAL_RECORD_FIELD_SET,
      APPROVAL_RECORD_FIELDS,
      itemPath,
    );
    if (approval["version"] !== CONTROL_RECORD_VERSION) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${itemPath}.version`,
        `approval version must be ${CONTROL_RECORD_VERSION}`,
      );
    }
    for (const field of [
      "id",
      "proposalId",
      "installationId",
      "requestRealizationId",
      "executionRealizationId",
      "approvedBy",
    ] as const) {
      if (!requiredString(approval[field])) {
        throw controlError(
          "CONTROL_INVALID_RECORD",
          `${itemPath}.${field}`,
          `approval ${field} is required`,
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
      if (!isSha256Digest(approval[field])) {
        throw controlError(
          "CONTROL_INVALID_RECORD",
          `${itemPath}.${field}`,
          `approval ${field} is invalid`,
        );
      }
    }
    if (!isInteractionId(approval["interactionId"])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${itemPath}.interactionId`,
        "approval interactionId is invalid",
      );
    }
    if (!Number.isFinite(approval["approvedAt"])) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${itemPath}.approvedAt`,
        "approval approvedAt must be finite",
      );
    }
    const approvalId = approval["id"] as string;
    if (approvalIds.has(approvalId)) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${itemPath}.id`,
        `duplicate approval id: ${approvalId}`,
      );
    }
    approvalIds.add(approvalId);
    const approvedBy = approval["approvedBy"] as string;
    if (approvingActors.has(approvedBy)) {
      throw controlError(
        "CONTROL_INVALID_RECORD",
        `${itemPath}.approvedBy`,
        `duplicate approving actor: ${approvedBy}`,
      );
    }
    approvingActors.add(approvedBy);
  }
  return approvals as unknown as readonly Approval[];
}

/** Snapshot and validate one complete durable approval at a journal boundary. */
export function snapshotApprovalRecord(
  value: unknown,
  path = "approval",
): Approval {
  const approvals = snapshotApprovalRecords([value], path);
  return approvals[0]!;
}
