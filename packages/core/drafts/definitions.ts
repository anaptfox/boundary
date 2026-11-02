/**
 * The three Draft interactions, declared with {@link defineInteraction} like
 * any other Boundary interaction. None of them is a special case: the workflow that
 * turns a Draft into a Draft decision is expressed the same way an
 * application would express its own interactions.
 *
 * Schemas that carry an {@link InteractionContract} verbatim (the drafted
 * contract itself) stay loosely typed here (`type: "object"`). The contract's
 * own nested schemas are themselves arbitrary portable JSON Schema; Program
 * already owns their validation through {@link interactionContractIdentity} and
 * {@link verifyDraft}. Re-deriving a strict JSON Schema for "a JSON Schema
 * that contains a JSON Schema" would duplicate that ownership without adding
 * safety.
 */
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { JsonSchema, JsonValue } from "@foxworth/boundary/program";
// oxlint-disable-next-line no-unused-vars -- named here so emitted declarations reference these types instead of unresolvable relative paths
import type { InteractionDefinition } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
import { defineInteraction } from "@foxworth/boundary";
import { DRAFT_REJECT_REASONS } from "./types";

const SHA256_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

const DRAFT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    version: { const: 1 },
    contract: { type: "object" },
    gap: { type: "string", minLength: 1 },
    proposer: { type: "string", minLength: 1 },
    createdAt: { type: "string" },
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
  },
  required: [
    "version",
    "contract",
    "gap",
    "proposer",
    "createdAt",
    "draftDigest",
  ],
  additionalProperties: false,
});

const PROPOSE_OUTPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
  },
  required: ["draftDigest"],
  additionalProperties: false,
});

const DECISION_ACTOR_FIELDS = Object.freeze({
  decidedBy: { type: "string", minLength: 1 },
  decidedAt: { type: "string" },
});

const ACCEPT_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
    ...DECISION_ACTOR_FIELDS,
  },
  required: ["draftDigest", "decidedBy", "decidedAt"],
  additionalProperties: false,
});

const ACCEPT_OUTPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    contract: { type: "object" },
    contractDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
  },
  required: ["contract", "contractDigest"],
  additionalProperties: false,
});

const REJECT_REASON_SCHEMA: JsonSchema = Object.freeze({
  type: "string",
  enum: [...DRAFT_REJECT_REASONS],
});

const REJECT_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
    reason: REJECT_REASON_SCHEMA,
    ...DECISION_ACTOR_FIELDS,
  },
  required: ["draftDigest", "reason", "decidedBy", "decidedAt"],
  additionalProperties: false,
});

const REJECT_OUTPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
    reason: REJECT_REASON_SCHEMA,
  },
  required: ["draftDigest", "reason"],
  additionalProperties: false,
});

const NOT_FOUND_ERROR_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    draftDigest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
  },
  required: ["draftDigest"],
  additionalProperties: false,
});

const INVALID_DRAFT_ERROR_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
});

const INVALID_REASON_ERROR_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    reason: { type: "string" },
  },
  required: ["reason"],
  additionalProperties: false,
});

/**
 * A worker proposes a full contract that does not exist yet. Direct mode:
 * proposing never changes what is declared, so it stays ordinary and immediate.
 */
export const draftsPropose = defineInteraction({
  id: "drafts.propose",
  input: portableSchema(DRAFT_SCHEMA, "drafts.propose.input"),
  output: portableSchema(PROPOSE_OUTPUT_SCHEMA, "drafts.propose.output"),
  errors: {
    invalidDraft: portableSchema(
      INVALID_DRAFT_ERROR_SCHEMA,
      "drafts.propose.errors.invalidDraft",
    ),
  },
  summary: "Persist a proposed interaction contract that does not exist yet.",
  description:
    "Verifies and stores a Draft through the host-supplied DraftStore. Never " +
    "declares the drafted contract and never changes what the host serves.",
});

/**
 * An author accepts a Draft. Request mode by default: acceptance is a
 * decision, distinct from the host's separate act of recompiling a Program
 * that declares the accepted contract.
 */
export const draftsAccept = defineInteraction({
  id: "drafts.accept",
  input: portableSchema(ACCEPT_INPUT_SCHEMA, "drafts.accept.input"),
  output: portableSchema(ACCEPT_OUTPUT_SCHEMA, "drafts.accept.output"),
  errors: {
    draftNotFound: portableSchema(
      NOT_FOUND_ERROR_SCHEMA,
      "drafts.accept.errors.draftNotFound",
    ),
  },
  summary: "Record that a proposed contract is accepted as a declared interaction.",
  description:
    "Returns the accepted contract and its digest and records the decision. " +
    "Never mutates a live Program and never writes source files; the host " +
    "separately recompiles a Program that declares the accepted contract.",
});

/**
 * An author rejects a Draft with a reason from a closed set. Request mode by
 * default, for the same reason acceptance is: rejection is a decision.
 */
export const draftsReject = defineInteraction({
  id: "drafts.reject",
  input: portableSchema(REJECT_INPUT_SCHEMA, "drafts.reject.input"),
  output: portableSchema(REJECT_OUTPUT_SCHEMA, "drafts.reject.output"),
  errors: {
    draftNotFound: portableSchema(
      NOT_FOUND_ERROR_SCHEMA,
      "drafts.reject.errors.draftNotFound",
    ),
    invalidReason: portableSchema(
      INVALID_REASON_ERROR_SCHEMA,
      "drafts.reject.errors.invalidReason",
    ),
  },
  summary: "Record that a proposed contract is rejected.",
  description:
    "Takes a reason from a closed set: ordinary-code (a local helper, not an " +
    "interaction) or covered-by-existing (existing interactions already do this).",
});

/** The closed set of Draft interactions, ready for `compileInteractions`. */
export const draftsInteractions = Object.freeze({
  propose: draftsPropose,
  accept: draftsAccept,
  reject: draftsReject,
});
