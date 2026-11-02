import type { HandoffOutcome } from "@foxworth/boundary/handoff";

/**
 * The six things a model-facing adapter has to tell a caller apart, named
 * independently of transport. Every HandoffOutcome maps to exactly one.
 */
export type OutcomeKind =
  | "success"
  | "declared-error"
  | "denied"
  | "invalid"
  | "proposed"
  | "uncertain"
  | "failed";

export type OutcomeDescription = Readonly<{
  kind: OutcomeKind;
  /** One sentence or two a model can act on. Deterministic for the same outcome. */
  summary: string;
  /** Whether calling again is safe. `never` means the effect may have run. */
  repeat: "safe" | "after-fix" | "after-review" | "never";
  /** Whether the transport should flag the result as an error. */
  isError: boolean;
}>;

/**
 * Describe one checked outcome for a model. The wording is reviewed evidence:
 * `tests/conformance/v1/mcp-envelope.json` pins it for TypeScript and Rust.
 *
 * Uncertainty is never folded into failure: an outcome whose certainty is
 * `unknown` or `not-completed` says so, forbids a repeat, and names the
 * installation to check with.
 */
export function describeOutcome(outcome: HandoffOutcome): OutcomeDescription {
  const id = outcome.interactionId;
  const result = outcome.result;
  if (result.kind === "returned") {
    return Object.freeze({
      kind: "success",
      summary: `${id} completed and returned a value (certainty: completed).`,
      repeat: "safe",
      isError: false,
    });
  }
  if (result.kind === "proposed") {
    return Object.freeze({
      kind: "proposed",
      summary: `${id} was proposed, not run: a Proposal record now awaits host review (certainty: not-started). Do not call again to retry; the host decides.`,
      repeat: "after-review",
      isError: false,
    });
  }
  if (result.kind === "declared-error") {
    return Object.freeze({
      kind: "declared-error",
      summary: `${id} completed with its declared outcome "${result.code}" (certainty: completed). Read details before deciding what to do next.`,
      repeat: "after-fix",
      isError: true,
    });
  }
  if (result.kind === "denied") {
    return Object.freeze({
      kind: "denied",
      summary: `${id} was denied by the host (${result.code}); nothing ran (certainty: not-started).`,
      repeat: "never",
      isError: true,
    });
  }
  if (outcome.certainty === "unknown" || outcome.certainty === "not-completed") {
    return Object.freeze({
      kind: "uncertain",
      summary: `${id} may have run; its outcome is not known (certainty: ${outcome.certainty}). Do not repeat it. Check with installation ${outcome.installationId} before acting.`,
      repeat: "never",
      isError: true,
    });
  }
  if (result.cause === "invalid-input" || result.cause === "invalid-invocation") {
    const issues = result.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    return Object.freeze({
      kind: "invalid",
      summary: `${id} was not started: the ${result.cause === "invalid-input" ? "input" : "invocation"} was rejected before anything ran (certainty: not-started).${issues ? ` Issues: ${issues}.` : ""} Fix it and call again.`,
      repeat: "after-fix",
      isError: true,
    });
  }
  if (result.cause === "revoked") {
    return Object.freeze({
      kind: "failed",
      summary: `${id} was not started: this caller's view of the surface is outdated because its Binding was revoked (certainty: not-started). Obtain a fresh connection before calling again.`,
      repeat: "after-fix",
      isError: true,
    });
  }
  return Object.freeze({
    kind: "failed",
    summary: `${id} was not started: ${result.cause} (certainty: not-started). Nothing ran.`,
    repeat: "after-fix",
    isError: true,
  });
}

/** The `content[0].text` of a tool result: the summary, then the full outcome as JSON. */
export function outcomeText(outcome: HandoffOutcome): string {
  return `${describeOutcome(outcome).summary}\n${JSON.stringify(outcome, null, 2)}`;
}
