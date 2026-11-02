import {
  cloneJson,
  INTERACTION_ID_PATTERN,
  portableSchema,
  validateSchemaValue,
  type JsonSchema,
  type JsonValue,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import { controlError } from "./errors";
import { PUBLIC_PROPOSAL_SCHEMA } from "./proposal-records";
import { CONTROL_RECORD_VERSION } from "./types";
import type {
  AttemptRef,
  EffectResult,
  Grant,
  Receipt,
} from "./types";

const NON_BLANK = Object.freeze({
  type: "string",
  pattern: "\\S",
}) as JsonSchema;
const DIGEST = Object.freeze({
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
}) as JsonSchema;
const INTERACTION_ID = Object.freeze({
  type: "string",
  pattern: INTERACTION_ID_PATTERN,
}) as JsonSchema;
const SUBJECT = Object.freeze({
  type: "object",
  properties: {
    kind: NON_BLANK,
    id: NON_BLANK,
  },
  required: ["kind", "id"],
  additionalProperties: false,
}) as JsonSchema;

export type PublicGrant<Preview extends JsonValue = JsonValue> = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly proposalId: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly requestedBy: string;
  readonly approvedBy: readonly string[];
  readonly subject: Grant<Preview>["subject"];
  readonly preview: Preview;
  readonly issuedBy: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
};

export type PublicControlStatus = {
  readonly proposal: PublicProposalJson;
  readonly grant?: PublicGrant;
  readonly attempt?: AttemptRef;
  readonly receipt?: Receipt;
};

export type ControlApprovalDecision = {
  readonly allow: true;
};

export type ControlListFilter = {
  readonly interactionId?: string;
  readonly proposalId?: string;
};

export const CONTROL_REQUEST_INPUT_SCHEMA = portableSchema<{
  readonly interactionId: string;
  readonly input: JsonValue;
  readonly contractDigest?: Sha256Digest;
  readonly controlDigest?: Sha256Digest;
}>({
  type: "object",
  properties: {
    interactionId: INTERACTION_ID,
    input: {},
    contractDigest: DIGEST,
    controlDigest: DIGEST,
  },
  required: ["interactionId", "input"],
  additionalProperties: false,
});

export const CONTROL_APPROVE_INPUT_SCHEMA = portableSchema<{
  readonly proposalId: string;
  readonly decision: ControlApprovalDecision;
}>({
  type: "object",
  properties: {
    proposalId: NON_BLANK,
    decision: {
      type: "object",
      properties: { allow: { const: true } },
      required: ["allow"],
      additionalProperties: false,
    },
  },
  required: ["proposalId", "decision"],
  additionalProperties: false,
});

export type ControlStatusError = {
  readonly code: "CONTROL_NOT_FOUND";
  readonly proposalId: string;
};

export const CONTROL_STATUS_ERROR_SCHEMA = portableSchema<ControlStatusError>({
  type: "object",
  properties: {
    code: { const: "CONTROL_NOT_FOUND" },
    proposalId: NON_BLANK,
  },
  required: ["code", "proposalId"],
  additionalProperties: false,
});

export const CONTROL_PROPOSAL_ID_INPUT_SCHEMA = portableSchema<{
  readonly proposalId: string;
}>({
  type: "object",
  properties: { proposalId: NON_BLANK },
  required: ["proposalId"],
  additionalProperties: false,
});

export const CONTROL_GRANT_ID_INPUT_SCHEMA = portableSchema<{
  readonly grantId: string;
}>({
  type: "object",
  properties: { grantId: NON_BLANK },
  required: ["grantId"],
  additionalProperties: false,
});

export const CONTROL_ATTEMPT_ID_INPUT_SCHEMA = portableSchema<{
  readonly attemptId: string;
}>({
  type: "object",
  properties: { attemptId: NON_BLANK },
  required: ["attemptId"],
  additionalProperties: false,
});

export const CONTROL_LIST_INPUT_SCHEMA = portableSchema<{
  readonly filter?: ControlListFilter;
}>({
  type: "object",
  properties: {
    filter: {
      type: "object",
      properties: {
        interactionId: INTERACTION_ID,
        proposalId: NON_BLANK,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

export type PublicProposalJson = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly requestedBy: string;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly baselineSummary: string;
  readonly effects: readonly JsonValue[];
  readonly preview: JsonValue;
  readonly createdAt: number;
};

export const PUBLIC_PROPOSAL_OUTPUT_SCHEMA = portableSchema<PublicProposalJson>(
  PUBLIC_PROPOSAL_SCHEMA,
  "control.PublicProposal",
);

export const PUBLIC_GRANT_SCHEMA = portableSchema<PublicGrant & JsonValue>({
  type: "object",
  properties: {
    version: { const: CONTROL_RECORD_VERSION },
    id: NON_BLANK,
    proposalId: NON_BLANK,
    proposalDigest: DIGEST,
    bindingDigest: DIGEST,
    projectionDigest: DIGEST,
    installationId: NON_BLANK,
    installationDigest: DIGEST,
    expectedProgramDigest: DIGEST,
    actualProgramDigest: DIGEST,
    programDigest: DIGEST,
    controlDigest: DIGEST,
    interactionId: INTERACTION_ID,
    expectedContractDigest: DIGEST,
    contractDigest: DIGEST,
    requestRealizationId: NON_BLANK,
    executionRealizationId: NON_BLANK,
    controlRealizationDigest: DIGEST,
    requestedBy: NON_BLANK,
    approvedBy: { type: "array", items: NON_BLANK, minItems: 1 },
    subject: SUBJECT,
    preview: {},
    issuedBy: NON_BLANK,
    issuedAt: { type: "number" },
    expiresAt: { type: "number" },
  },
  required: [
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
    "requestedBy",
    "approvedBy",
    "subject",
    "preview",
    "issuedBy",
    "issuedAt",
  ],
  additionalProperties: false,
});

const ATTEMPT_REF_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    version: { const: CONTROL_RECORD_VERSION },
    id: NON_BLANK,
    proposalId: NON_BLANK,
    bindingDigest: DIGEST,
    projectionDigest: DIGEST,
    installationId: NON_BLANK,
    installationDigest: DIGEST,
    expectedProgramDigest: DIGEST,
    actualProgramDigest: DIGEST,
    programDigest: DIGEST,
    interactionId: INTERACTION_ID,
    expectedContractDigest: DIGEST,
    contractDigest: DIGEST,
    requestRealizationId: NON_BLANK,
    executionRealizationId: NON_BLANK,
    controlRealizationDigest: DIGEST,
    controlDigest: DIGEST,
  },
  required: [
    "version",
    "id",
    "proposalId",
    "bindingDigest",
    "projectionDigest",
    "installationId",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "programDigest",
    "interactionId",
    "expectedContractDigest",
    "contractDigest",
    "requestRealizationId",
    "executionRealizationId",
    "controlRealizationDigest",
    "controlDigest",
  ],
  additionalProperties: false,
}) as JsonSchema;

const RECEIPT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    version: { const: CONTROL_RECORD_VERSION },
    id: NON_BLANK,
    attemptId: NON_BLANK,
    proposalId: NON_BLANK,
    proposalDigest: DIGEST,
    bindingDigest: DIGEST,
    projectionDigest: DIGEST,
    installationId: NON_BLANK,
    installationDigest: DIGEST,
    expectedProgramDigest: DIGEST,
    actualProgramDigest: DIGEST,
    programDigest: DIGEST,
    grantId: NON_BLANK,
    controlDigest: DIGEST,
    interactionId: INTERACTION_ID,
    expectedContractDigest: DIGEST,
    contractDigest: DIGEST,
    requestRealizationId: NON_BLANK,
    executionRealizationId: NON_BLANK,
    controlRealizationDigest: DIGEST,
    output: {},
    evidence: {},
    completedAt: { type: "number" },
  },
  required: [
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
  ],
  additionalProperties: false,
}) as JsonSchema;

export const PUBLIC_EFFECT_RESULT_SCHEMA = portableSchema<
  EffectResult<JsonValue> & JsonValue
>({
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed" },
        value: {},
        receipt: RECEIPT_SCHEMA,
      },
      required: ["status", "value", "receipt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "uncertain" },
        attempt: ATTEMPT_REF_SCHEMA,
      },
      required: ["status", "attempt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "not-applied" },
        reason: NON_BLANK,
      },
      required: ["status", "reason"],
      additionalProperties: false,
    },
  ],
});

export const PUBLIC_CONTROL_STATUS_SCHEMA = portableSchema<
  PublicControlStatus & JsonValue
>({
  type: "object",
  properties: {
    proposal: PUBLIC_PROPOSAL_SCHEMA,
    grant: PUBLIC_GRANT_SCHEMA,
    attempt: ATTEMPT_REF_SCHEMA,
    receipt: RECEIPT_SCHEMA,
  },
  required: ["proposal"],
  additionalProperties: false,
});

export const PUBLIC_CONTROL_STATUS_LIST_SCHEMA = portableSchema<
  readonly (PublicControlStatus & JsonValue)[]
>({
  type: "array",
  items: PUBLIC_CONTROL_STATUS_SCHEMA,
});

/** Snapshot and validate one complete durable grant at a journal boundary. */
export function snapshotGrantRecord<Preview extends JsonValue = JsonValue>(
  value: unknown,
  path = "grant",
): Grant<Preview> {
  let normalized: JsonValue;
  try {
    normalized = cloneJson(value as JsonValue, path);
  } catch (error) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      path,
      error instanceof Error ? error.message : "grant must be portable JSON",
      error,
    );
  }
  const issue = validateSchemaValue(PUBLIC_GRANT_SCHEMA, normalized, path)[0];
  if (issue) {
    throw controlError("CONTROL_INVALID_RECORD", issue.path, issue.message);
  }
  return normalized as unknown as Grant<Preview>;
}

export function publicGrant<Preview extends JsonValue>(
  grant: Grant<Preview>,
): PublicGrant<Preview> {
  const source = snapshotGrantRecord<Preview>(grant);
  return Object.freeze({
    version: source.version,
    id: source.id,
    proposalId: source.proposalId,
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
    approvedBy: source.approvedBy,
    subject: source.subject,
    preview: source.preview,
    issuedBy: source.issuedBy,
    issuedAt: source.issuedAt,
    ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
  });
}

export type { EffectResult };
