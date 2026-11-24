import {
  cloneJson,
  hashJson,
  isInteractionId,
  isSha256Digest,
  jsonEquals,
  INTERACTION_ID_PATTERN,
  validateSchemaValue,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import { controlError } from "./errors";
import {
  isObject,
  projectionSourceSnapshot,
  requiredString,
  requireExactFields,
  snapshot,
} from "./record-snapshot";
import { CONTROL_RECORD_VERSION } from "./types";
import type { Grant, Proposal, ProposalRecord } from "./types";

export const CONTROL_PROPOSAL_DOMAIN = "boundary.control-proposal/v1";

const NON_BLANK_STRING_SCHEMA = Object.freeze({
  type: "string",
  pattern: "\\S",
}) as JsonSchema;
const DIGEST_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
}) as JsonSchema;
const SUBJECT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    kind: NON_BLANK_STRING_SCHEMA,
    id: NON_BLANK_STRING_SCHEMA,
  },
  required: ["kind", "id"],
  additionalProperties: false,
}) as JsonSchema;
const EFFECT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    kind: NON_BLANK_STRING_SCHEMA,
    action: NON_BLANK_STRING_SCHEMA,
    resource: NON_BLANK_STRING_SCHEMA,
    description: { type: "string" },
    details: { type: "object" },
  },
  required: ["kind", "action", "resource"],
  additionalProperties: false,
}) as JsonSchema;

/** JSON Schema used by every projected public-proposal surface. */
export const PUBLIC_PROPOSAL_SCHEMA = cloneJson(
  {
    type: "object",
    properties: {
      version: { const: CONTROL_RECORD_VERSION },
      id: NON_BLANK_STRING_SCHEMA,
      proposalDigest: DIGEST_SCHEMA,
      bindingDigest: DIGEST_SCHEMA,
      projectionDigest: DIGEST_SCHEMA,
      installationId: NON_BLANK_STRING_SCHEMA,
      installationDigest: DIGEST_SCHEMA,
      expectedProgramDigest: DIGEST_SCHEMA,
      actualProgramDigest: DIGEST_SCHEMA,
      programDigest: DIGEST_SCHEMA,
      controlDigest: DIGEST_SCHEMA,
      interactionId: {
        type: "string",
        pattern: INTERACTION_ID_PATTERN,
      },
      expectedContractDigest: DIGEST_SCHEMA,
      contractDigest: DIGEST_SCHEMA,
      requestRealizationId: NON_BLANK_STRING_SCHEMA,
      executionRealizationId: NON_BLANK_STRING_SCHEMA,
      controlRealizationDigest: DIGEST_SCHEMA,
      requestedBy: NON_BLANK_STRING_SCHEMA,
      subject: SUBJECT_SCHEMA,
      baselineSummary: NON_BLANK_STRING_SCHEMA,
      effects: {
        type: "array",
        items: EFFECT_SCHEMA,
        minItems: 1,
      },
      preview: {},
      createdAt: { type: "number" },
    },
    required: [
      "version",
      "id",
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
      "requestedBy",
      "subject",
      "baselineSummary",
      "effects",
      "preview",
      "createdAt",
    ],
    additionalProperties: false,
  },
  "PUBLIC_PROPOSAL_SCHEMA",
) as JsonSchema;

export type ProposalIntegrity =
  | { readonly status: "valid"; readonly proposal: ProposalRecord }
  | { readonly status: "invalid"; readonly reason: string };

const PROPOSAL_RECORD_FIELDS = Object.freeze([
  "version",
  "id",
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
  "requestedBy",
  "input",
  "subject",
  "baseline",
  "baselineSummary",
  "effects",
  "state",
  "preview",
  "createdAt",
] as const);
const PROPOSAL_RECORD_FIELD_SET = new Set<string>(PROPOSAL_RECORD_FIELDS);

/** Snapshot and enforce the exact public proposal contract owned by Control. */
export function normalizePublicProposal<
  Preview extends JsonValue = JsonValue,
>(value: unknown, path: string): Proposal<Preview> {
  let normalized: JsonValue;
  try {
    normalized = cloneJson(value as JsonValue, path);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      error instanceof Error ? error.message : "proposal must be portable JSON",
      error,
    );
  }
  const issues = validateSchemaValue(PUBLIC_PROPOSAL_SCHEMA, normalized, path);
  const first = issues[0];
  if (first) {
    throw controlError("CONTROL_INVALID_RECORD", first.path, first.message);
  }
  const proposal = normalized as unknown as Proposal<Preview>;
  if (!isInteractionId(proposal.interactionId)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      `${path}.interactionId`,
      "interactionId must be a stable ASCII token of at most 128 characters",
    );
  }
  return proposal;
}

function proposalShapeIssue(value: unknown): string | undefined {
  if (!isObject(value)) return "proposal must be an object";
  const unexpected = Object.keys(value).find(
    (field) => !PROPOSAL_RECORD_FIELD_SET.has(field),
  );
  if (unexpected !== undefined) {
    return `proposal has unexpected field: ${unexpected}`;
  }
  const missing = PROPOSAL_RECORD_FIELDS.find(
    (field) => !Object.hasOwn(value, field),
  );
  if (missing !== undefined) return `proposal ${missing} is required`;
  if (value["version"] !== CONTROL_RECORD_VERSION) {
    return `proposal version must be ${CONTROL_RECORD_VERSION}`;
  }
  for (const field of [
    "id",
    "installationId",
    "interactionId",
    "requestRealizationId",
    "executionRealizationId",
    "requestedBy",
    "baselineSummary",
  ] as const) {
    if (!requiredString(value[field])) return `proposal ${field} is required`;
  }
  if (!isInteractionId(value["interactionId"])) {
    return "proposal interactionId is invalid";
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
    if (!isSha256Digest(value[field])) return `proposal ${field} is invalid`;
  }
  if (!Number.isFinite(value["createdAt"])) {
    return "proposal createdAt must be finite";
  }
  const subject = value["subject"];
  if (
    !isObject(subject) ||
    !requiredString(subject["kind"]) ||
    !requiredString(subject["id"]) ||
    Object.keys(subject).some((field) => field !== "kind" && field !== "id")
  ) {
    return "proposal subject kind and id are required";
  }
  if (!Array.isArray(value["effects"]) || value["effects"].length === 0) {
    return "proposal effects are required";
  }
  for (const effect of value["effects"]) {
    if (
      !isObject(effect) ||
      !requiredString(effect["kind"]) ||
      !requiredString(effect["action"]) ||
      !requiredString(effect["resource"]) ||
      Object.keys(effect).some(
        (field) =>
          field !== "kind" &&
          field !== "action" &&
          field !== "resource" &&
          field !== "description" &&
          field !== "details",
      ) ||
      (effect["description"] !== undefined &&
        typeof effect["description"] !== "string") ||
      (effect["details"] !== undefined && !isObject(effect["details"]))
    ) {
      return "proposal effect kind, action, and resource are required";
    }
  }
  for (const field of [
    "input",
    "baseline",
    "state",
    "preview",
  ] as const) {
    if (!(field in value)) return `proposal ${field} is required`;
  }
  return undefined;
}

function requireProposalProjectionSource<Preview extends JsonValue>(
  value: ProposalRecord<Preview>,
): ProposalRecord<Preview> {
  const proposal = projectionSourceSnapshot(value, "proposal");
  if (!isObject(proposal)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "proposal",
      "proposal must be an object",
    );
  }
  if (proposal["version"] !== CONTROL_RECORD_VERSION) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "proposal.version",
      `proposal version must be ${CONTROL_RECORD_VERSION}`,
    );
  }
  requireExactFields(
    proposal,
    PROPOSAL_RECORD_FIELD_SET,
    PROPOSAL_RECORD_FIELDS,
    "proposal",
  );
  const issue = proposalShapeIssue(proposal);
  if (issue) {
    throw controlError("CONTROL_INVALID_RECORD", "proposal", issue);
  }
  return proposal as ProposalRecord<Preview>;
}

export function proposalDigest(
  proposal: Omit<ProposalRecord, "proposalDigest">,
): Sha256Digest {
  return hashJson(
    CONTROL_PROPOSAL_DOMAIN,
    snapshot(proposal, "proposal") as unknown as JsonObject,
  );
}

export function verifyProposalIntegrity(
  value: ProposalRecord,
): ProposalIntegrity {
  try {
    const proposal = snapshot(value, "proposal");
    const issue = proposalShapeIssue(proposal);
    if (issue) return Object.freeze({ status: "invalid", reason: issue });
    const { proposalDigest: actual, ...identity } = proposal;
    const expected = proposalDigest(identity);
    if (actual !== expected) {
      return Object.freeze({
        status: "invalid",
        reason: "proposal digest does not match its content",
      });
    }
    return Object.freeze({ status: "valid", proposal });
  } catch (error) {
    return Object.freeze({
      status: "invalid",
      reason:
        error instanceof Error ? error.message : "proposal is not portable JSON",
    });
  }
}

export function requireValidProposal(
  value: ProposalRecord,
): ProposalRecord {
  const integrity = verifyProposalIntegrity(value);
  if (integrity.status === "invalid") {
    throw controlError(
      "CONTROL_INTEGRITY_MISMATCH",
      "proposal.proposalDigest",
      integrity.reason,
    );
  }
  return integrity.proposal;
}

const projectedPublicProposals = new WeakMap<object, Proposal<any>>();

export function publicProposal<Preview extends JsonValue>(
  proposal: ProposalRecord<Preview>,
): Proposal<Preview> {
  const cached = projectedPublicProposals.get(proposal);
  if (cached) return cached as Proposal<Preview>;
  const source = requireProposalProjectionSource(proposal);
  const cachedSource = projectedPublicProposals.get(source);
  if (cachedSource) {
    projectedPublicProposals.set(proposal, cachedSource);
    return cachedSource as Proposal<Preview>;
  }
  const projected = Object.freeze({
    version: CONTROL_RECORD_VERSION,
    id: source.id,
    proposalDigest: source.proposalDigest,
    bindingDigest: source.bindingDigest,
    projectionDigest: source.projectionDigest,
    installationId: source.installationId,
    installationDigest: source.installationDigest,
    expectedProgramDigest: source.expectedProgramDigest,
    actualProgramDigest: source.actualProgramDigest,
    programDigest: source.programDigest,
    controlDigest: source.controlDigest,
    interactionId: source.interactionId,
    expectedContractDigest: source.expectedContractDigest,
    contractDigest: source.contractDigest,
    requestRealizationId: source.requestRealizationId,
    executionRealizationId: source.executionRealizationId,
    controlRealizationDigest: source.controlRealizationDigest,
    requestedBy: source.requestedBy,
    subject: source.subject,
    baselineSummary: source.baselineSummary,
    effects: source.effects,
    preview: source.preview,
    createdAt: source.createdAt,
  }) as Proposal<Preview>;
  projectedPublicProposals.set(proposal, projected);
  if (source !== proposal) projectedPublicProposals.set(source, projected);
  return projected;
}

export function publicHandleMatches(
  handle: Proposal,
  record: ProposalRecord,
): boolean {
  try {
    return (
      handle.id === record.id &&
      handle.proposalDigest === record.proposalDigest &&
      jsonEquals(
        handle as unknown as JsonValue,
        publicProposal(record) as unknown as JsonValue,
      )
    );
  } catch {
    return false;
  }
}

export function grantMatchesProposal(
  grant: Grant,
  proposal: ProposalRecord,
): boolean {
  return (
    grant.version === CONTROL_RECORD_VERSION &&
    requiredString(grant.id) &&
    grant.proposalId === proposal.id &&
    grant.proposalDigest === proposal.proposalDigest &&
    grant.bindingDigest === proposal.bindingDigest &&
    grant.projectionDigest === proposal.projectionDigest &&
    grant.installationId === proposal.installationId &&
    grant.installationDigest === proposal.installationDigest &&
    grant.expectedProgramDigest === proposal.expectedProgramDigest &&
    grant.actualProgramDigest === proposal.actualProgramDigest &&
    grant.programDigest === proposal.programDigest &&
    grant.controlDigest === proposal.controlDigest &&
    grant.interactionId === proposal.interactionId &&
    grant.expectedContractDigest === proposal.expectedContractDigest &&
    grant.contractDigest === proposal.contractDigest &&
    grant.requestRealizationId === proposal.requestRealizationId &&
    grant.executionRealizationId === proposal.executionRealizationId &&
    grant.controlRealizationDigest === proposal.controlRealizationDigest &&
    grant.requestedBy === proposal.requestedBy &&
    jsonEquals(
      grant.subject as unknown as JsonValue,
      proposal.subject as unknown as JsonValue,
    ) &&
    jsonEquals(
      grant.preview as unknown as JsonValue,
      proposal.preview as unknown as JsonValue,
    ) &&
    requiredString(grant.issuedBy) &&
    Number.isFinite(grant.issuedAt) &&
    (grant.expiresAt === undefined || Number.isFinite(grant.expiresAt)) &&
    Array.isArray(grant.approvedBy) &&
    grant.approvedBy.length > 0 &&
    grant.approvedBy.every(requiredString)
  );
}

export { approvalMatchesProposal, snapshotApprovalRecords } from "./approval-records";
