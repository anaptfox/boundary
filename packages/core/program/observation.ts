import { isInteractionId } from "./program";
import { isSha256Digest, normalizeJson, type JsonValue } from "./json";
import type { RawInvocationOutcome } from "./artifacts";

/** Host-published evidence. Correlation identifies a call, never authorizes or deduplicates it. */
export type InvocationObservation = Readonly<
  Omit<RawInvocationOutcome, "result"> & {
    version: 1;
    resultKind: RawInvocationOutcome["result"]["kind"];
    reads: readonly string[];
    changes: readonly string[];
    correlation?: JsonValue;
  }
>;

/** Validate data received from a host-chosen observation channel. This does not authenticate its publisher. */
export function validateInvocationObservation(value: unknown): InvocationObservation {
  const event = normalizeJson(value) as Record<string, JsonValue>;
  if (!event || Array.isArray(event) || typeof event !== "object") throw new TypeError("invalid invocation observation");
  const required = ["version", "bindingDigest", "projectionDigest", "installationId", "installationDigest", "interactionId", "expectedContractDigest", "actualContractDigest", "mode", "realizationId", "certainty", "resultKind", "reads", "changes"];
  if (required.some((key) => !Object.hasOwn(event, key)) || Object.keys(event).some((key) => !required.includes(key) && key !== "correlation")) throw new TypeError("invalid observation fields");
  for (const key of ["bindingDigest", "projectionDigest", "installationDigest", "expectedContractDigest", "actualContractDigest"]) {
    if (!isSha256Digest(event[key])) throw new TypeError(`invalid observation ${key}`);
  }
  for (const key of ["installationId", "realizationId"]) {
    if (typeof event[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(event[key])) throw new TypeError(`invalid observation ${key}`);
  }
  for (const key of ["reads", "changes"]) {
    const resources = event[key];
    if (!Array.isArray(resources) || resources.some((resource) => typeof resource !== "string" || resource.length === 0)) throw new TypeError(`invalid observation ${key}`);
  }
  const legal = event.resultKind === "fault"
    ? ["not-started", "not-completed", "unknown"].includes(String(event.certainty))
    : event.resultKind === "proposed"
      ? event.mode === "request" && event.certainty === "not-started"
      : event.resultKind === "denied"
        ? event.certainty === "not-started"
        : ["returned", "declared-error"].includes(String(event.resultKind)) && event.mode === "direct" && event.certainty === "completed";
  if (event.version !== 1 || !isInteractionId(event.interactionId) || !["direct", "request"].includes(String(event.mode)) || !legal) throw new TypeError("invalid observation outcome");
  return event as unknown as InvocationObservation;
}
