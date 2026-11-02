import { cloneJson, isInteractionId, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import type {
  ControlReaderScope,
  ControlSubject,
} from "./types";

function invalidScope(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function portableSnapshot(value: unknown, path: string): JsonValue {
  try {
    return cloneJson(value as JsonValue, path);
  } catch {
    return invalidScope(path, "scope must be exact portable data");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !expected.includes(key));
  if (unexpected !== undefined) {
    invalidScope(`${path}.${unexpected}`, "unexpected scope field");
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    invalidScope(`${path}.${missing}`, "required scope field is missing");
  }
}

function subject(value: unknown, path: string): ControlSubject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidScope(path, "tenant must be an exact subject");
  }
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["kind", "id"], path);
  if (typeof raw.kind !== "string" || raw.kind.trim().length === 0) {
    invalidScope(`${path}.kind`, "tenant kind must be a non-empty string");
  }
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    invalidScope(`${path}.id`, "tenant id must be a non-empty string");
  }
  return Object.freeze({ kind: raw.kind, id: raw.id });
}

/** Snapshot caller-owned scope data so later mutation cannot widen observation. */
export function snapshotControlReaderScope(
  value: ControlReaderScope,
): ControlReaderScope {
  const owned = portableSnapshot(value, "control.reader.scope");
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) {
    return invalidScope("control.reader.scope", "scope is required");
  }
  const raw = owned as Record<string, unknown>;
  exactKeys(raw, ["interactionIds", "tenant"], "control.reader.scope");
  if (!Array.isArray(raw.interactionIds) || raw.interactionIds.length === 0) {
    invalidScope(
      "control.reader.scope.interactionIds",
      "at least one interaction id is required",
    );
  }
  const interactionIds = raw.interactionIds.map((interactionId, index) => {
    if (!isInteractionId(interactionId)) {
      return invalidScope(
        `control.reader.scope.interactionIds[${index}]`,
        "interaction id is invalid",
      );
    }
    return interactionId;
  });
  if (new Set(interactionIds).size !== interactionIds.length) {
    invalidScope(
      "control.reader.scope.interactionIds",
      "interaction ids must be unique",
    );
  }
  interactionIds.sort(compareUtf8);
  return Object.freeze({
    interactionIds: Object.freeze(interactionIds),
    tenant: subject(raw.tenant, "control.reader.scope.tenant"),
  });
}

function scopedProposalIdentity(value: unknown): Readonly<{
  interactionId: string;
  subject: ControlSubject;
}> | undefined {
  let owned: JsonValue;
  try {
    owned = cloneJson(value as JsonValue, "control.reader.record");
  } catch {
    return undefined;
  }
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) {
    return undefined;
  }
  const raw = owned as Record<string, unknown>;
  if (!isInteractionId(raw.interactionId)) return undefined;
  const rawSubject = raw.subject;
  if (!rawSubject || typeof rawSubject !== "object" || Array.isArray(rawSubject)) {
    return undefined;
  }
  const candidate = rawSubject as Record<string, unknown>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.id !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    interactionId: raw.interactionId,
    subject: Object.freeze({ kind: candidate.kind, id: candidate.id }),
  });
}

export function controlReaderScopeIncludes(
  scope: ControlReaderScope,
  proposal: unknown,
): boolean {
  const identity = scopedProposalIdentity(proposal);
  return identity !== undefined &&
    scope.interactionIds.includes(identity.interactionId) &&
    identity.subject.kind === scope.tenant.kind &&
    identity.subject.id === scope.tenant.id;
}

export function controlRecordProposalId(value: unknown): string | undefined {
  let owned: JsonValue;
  try {
    owned = cloneJson(value as JsonValue, "control.reader.record");
  } catch {
    return undefined;
  }
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) {
    return undefined;
  }
  const proposalId = (owned as Record<string, unknown>).proposalId;
  return typeof proposalId === "string" && proposalId.trim().length > 0
    ? proposalId
    : undefined;
}
