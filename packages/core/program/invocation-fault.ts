import type { InteractionMode, InvocationCertainty } from "./artifacts";

/** The shared v1 stable fault law, used for retained native and Handoff outcomes. */
export function isInvocationFaultLegal(mode: InteractionMode, cause: string, certainty: InvocationCertainty): boolean {
  switch (cause) {
    case "invalid-input": case "revoked": case "admission-failed": case "invalid-invocation":
      return certainty === "not-started";
    case "request-failed": return mode === "request" && certainty === "not-started";
    case "invalid-realization-outcome": return mode === "direct" && certainty === "unknown";
    case "realization-failed": return certainty === "unknown"
      || (mode === "direct" && (certainty === "not-started" || certainty === "not-completed"));
    default: return false;
  }
}
