import { BoundaryErrorBase } from "@foxworth/boundary/program";

export type ControlDiagnosticCode =
  | "CONTROL_NOT_CONFIGURED"
  | "CONTROL_INVALID_REALIZATION"
  | "CONTROL_INVALID_PLAN"
  | "CONTROL_INVALID_RECORD"
  | "CONTROL_INTEGRITY_MISMATCH"
  | "CONTROL_POLICY_DENIED"
  | "CONTROL_PREFLIGHT_FAILED"
  | "CONTROL_UNKNOWN_PROPOSAL"
  | "CONTROL_UNKNOWN_GRANT"
  | "CONTROL_UNKNOWN_ATTEMPT"
  | "CONTROL_EXPIRED_GRANT"
  | "CONTROL_JOURNAL_CONFLICT"
  | "CONTROL_INVALID_CLOCK"
  | "CONTROL_INVALID_ID"
  | "CONTROL_INVALID_LEASE";

/** Stable pre-attempt failure. Once an attempt exists, failures are contained. */
export class ControlError extends BoundaryErrorBase {
  declare readonly code: ControlDiagnosticCode;

  constructor(
    code: ControlDiagnosticCode,
    path: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(code, path, message, options);
    this.name = "ControlError";
  }
}

export function controlError(
  code: ControlDiagnosticCode,
  path: string,
  message: string,
  cause?: unknown,
): ControlError {
  return new ControlError(code, path, message, { cause });
}
