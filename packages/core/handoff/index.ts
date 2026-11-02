/** `@foxworth/boundary/handoff`: the checked, host-neutral invocation seam. */
export { validateBindingManifest } from "./manifest";
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
  BindingManifest,
  BindingInteraction,
} from "@foxworth/boundary/program";
