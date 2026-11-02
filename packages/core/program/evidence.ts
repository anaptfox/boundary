import { BoundaryErrorBase } from "./errors";
import { normalizeJson, type JsonObject, type JsonValue } from "./json";
import { validateInvocationObservation, type InvocationObservation } from "./observation";

export type EvidenceReferenceKind = "evidence" | "invocation" | "subject" | "attempt" | "receipt";

/** A host-issued public identity. Namespace and ID together identify one entity. */
export type EvidenceReference<Kind extends EvidenceReferenceKind = EvidenceReferenceKind> = Readonly<{
  kind: Kind;
  namespace: string;
  id: string;
}>;

export type EvidenceSubjectState = "pending" | "completed" | "not-started" | "not-completed" | "uncertain";

/**
 * Explicit host-published links, separate from invocation observation v1 and
 * private observed-read evidence. Missing links remain missing evidence. The
 * envelope does not authenticate its publisher, grant authority, instruct retry,
 * or assert a global event order.
 */
export type ExecutionEvidence = Readonly<{
  version: 1;
  reference: EvidenceReference<"evidence">;
  invocation: Readonly<{
    reference: EvidenceReference<"invocation">;
    observation: InvocationObservation;
  }>;
  subject?: Readonly<{
    reference: EvidenceReference<"subject">;
    state: EvidenceSubjectState;
  }>;
  parents?: readonly EvidenceReference[];
  children?: readonly EvidenceReference[];
  attempt?: EvidenceReference<"attempt">;
  receipt?: EvidenceReference<"receipt">;
}>;

export type ExecutionEvidenceDiagnosticCode = "INVALID_EXECUTION_EVIDENCE" | "CONFLICTING_EVIDENCE_REFERENCE" | "DUPLICATE_EVIDENCE_REFERENCE";

export class ExecutionEvidenceError extends BoundaryErrorBase {
  declare readonly code: ExecutionEvidenceDiagnosticCode;
  constructor(code: ExecutionEvidenceDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "ExecutionEvidenceError";
  }
}

const kinds: readonly EvidenceReferenceKind[] = ["evidence", "invocation", "subject", "attempt", "receipt"];
const states: readonly EvidenceSubjectState[] = ["pending", "completed", "not-started", "not-completed", "uncertain"];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u;

function fail(path: string, message: string): never {
  throw new ExecutionEvidenceError("INVALID_EXECUTION_EVIDENCE", path, message);
}

function object(value: JsonValue | undefined, required: readonly string[], optional: readonly string[], path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an evidence object");
  const record = value as JsonObject;
  if (required.some(key => !Object.hasOwn(record, key))) fail(path, "required evidence fields are missing");
  const extra = Object.keys(record).find(key => !required.includes(key) && !optional.includes(key));
  if (extra !== undefined) fail(`${path}.${extra}`, "unknown evidence field");
  return record;
}

function reference<Kind extends EvidenceReferenceKind>(value: JsonValue | undefined, allowed: readonly Kind[], path: string): EvidenceReference<Kind> {
  const record = object(value, ["kind", "namespace", "id"], [], path);
  if (typeof record.kind !== "string" || !allowed.includes(record.kind as Kind)) fail(`${path}.kind`, "reference has the wrong entity kind");
  for (const key of ["namespace", "id"]) {
    if (typeof record[key] !== "string" || !identifier.test(record[key])) fail(`${path}.${key}`, "reference identity must be 1-256 bounded ASCII identifier characters");
  }
  return record as unknown as EvidenceReference<Kind>;
}

function key(value: EvidenceReference): string {
  return `${value.namespace}\0${value.id}`;
}

/** Strictly validate, clone and deeply freeze an execution evidence envelope. */
export function validateExecutionEvidence(value: unknown): ExecutionEvidence {
  const envelope = object(normalizeJson(value, "evidence"), ["version", "reference", "invocation"], ["subject", "parents", "children", "attempt", "receipt"], "evidence");
  if (envelope.version !== 1) fail("evidence.version", "unsupported execution evidence version");
  const own = reference(envelope.reference, ["evidence"], "evidence.reference");
  const invocation = object(envelope.invocation, ["reference", "observation"], [], "evidence.invocation");
  const invoked = reference(invocation.reference, ["invocation"], "evidence.invocation.reference");
  validateInvocationObservation(invocation.observation);
  const identities = new Map<string, EvidenceReferenceKind>();
  const remember = (ref: EvidenceReference, path: string) => {
    const previous = identities.get(key(ref));
    if (previous !== undefined && previous !== ref.kind) {
      throw new ExecutionEvidenceError("CONFLICTING_EVIDENCE_REFERENCE", path, "one namespace and ID cannot identify different entity kinds");
    }
    identities.set(key(ref), ref.kind);
  };
  remember(own, "evidence.reference");
  remember(invoked, "evidence.invocation.reference");
  if (envelope.subject !== undefined) {
    const subject = object(envelope.subject, ["reference", "state"], [], "evidence.subject");
    remember(reference(subject.reference, ["subject"], "evidence.subject.reference"), "evidence.subject.reference");
    if (typeof subject.state !== "string" || !states.includes(subject.state as EvidenceSubjectState)) fail("evidence.subject.state", "unsupported subject state");
  }
  for (const field of ["attempt", "receipt"] as const) {
    if (envelope[field] !== undefined) remember(reference(envelope[field], [field], `evidence.${field}`), `evidence.${field}`);
  }
  const linked = new Map<string, string>();
  for (const field of ["parents", "children"] as const) {
    const links = envelope[field];
    if (links === undefined) continue;
    if (!Array.isArray(links) || links.length > 128) fail(`evidence.${field}`, "causal links must be an array with at most 128 references");
    for (const [index, raw] of links.entries()) {
      const path = `evidence.${field}[${index}]`;
      const ref = reference(raw, kinds, path);
      remember(ref, path);
      if (key(ref) === key(own) || key(ref) === key(invoked)) {
        throw new ExecutionEvidenceError("CONFLICTING_EVIDENCE_REFERENCE", path, "evidence and its invocation cannot be their own causal links");
      }
      const previous = linked.get(key(ref));
      if (previous !== undefined) {
        throw new ExecutionEvidenceError(previous === field ? "DUPLICATE_EVIDENCE_REFERENCE" : "CONFLICTING_EVIDENCE_REFERENCE", path, "causal references must be unique and cannot be both parents and children");
      }
      linked.set(key(ref), field);
    }
  }
  return envelope as unknown as ExecutionEvidence;
}
