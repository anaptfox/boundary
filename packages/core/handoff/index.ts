/** `@foxworth/boundary/handoff`: the checked, host-neutral invocation seam. */
export { validateProjectionBindingManifest } from "./manifest";
export { validateHandoffInvocation, validateHandoffOutcome, validateHandoffOutcomeAgainstManifest, validateHandoffResponse } from "./messages";
export { executeHandoff, createHandoffInvocation, createCheckedHandoff } from "./execute";
export { HandoffError, type HandoffDiagnosticCode } from "./errors";
export type {
  CheckedHandoff,
  HandoffBindingInvocation,
  HandoffExecutable,
  HandoffFaultCause,
  HandoffInvocation,
  HandoffOutcome,
  HandoffResolvedInteraction,
  HandoffResult,
  HandoffValidationIssue,
} from "./types";
export type {
  ProjectionBindingManifest,
  ProjectionBindingInteraction,
} from "@foxworth/boundary/program";
