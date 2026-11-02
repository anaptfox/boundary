import { validateExecutionEvidence, type ExecutionEvidence } from "@foxworth/boundary/program";
import type { MaybePromise } from "./types";

/** Private host delivery capability; accepting evidence grants no authority. */
export interface ExecutionEvidencePublisher {
  publish(evidence: ExecutionEvidence): MaybePromise<void>;
}

export type ExecutionEvidencePublication = Readonly<
  | { status: "published"; evidence: ExecutionEvidence }
  | { status: "delivery-failed"; evidence: ExecutionEvidence; cause: unknown }
>;

/**
 * Explicitly publish a host-selected envelope. Validation precedes delivery;
 * delivery failure retains evidence and cannot rewrite execution/subject truth.
 * No invocation hook, read token export, authentication or retry is implied.
 */
export async function publishExecutionEvidence(publisher: ExecutionEvidencePublisher, value: unknown): Promise<ExecutionEvidencePublication> {
  const evidence = validateExecutionEvidence(value);
  const publish = publisher?.publish;
  if (typeof publish !== "function") throw new TypeError("execution evidence publisher must provide publish()");
  try {
    await publish.call(publisher, evidence);
    return Object.freeze({ status: "published", evidence });
  } catch (cause) {
    return Object.freeze({ status: "delivery-failed", evidence, cause });
  }
}
