import { BoundaryErrorBase } from "@foxworth/boundary/program";
import type { HandoffValidationIssue } from "./types";

export type HandoffDiagnosticCode =
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_VERSION"
  | "INVALID_INVOCATION"
  | "STALE_BINDING"
  | "STALE_INSTALLATION"
  | "INTERACTION_NOT_EXPOSED"
  | "MODE_NOT_EXPOSED"
  | "STALE_CONTRACT"
  | "STALE_REALIZATION"
  | "INVALID_INPUT"
  | "INVALID_OUTCOME";

export class HandoffError extends BoundaryErrorBase {
  declare readonly code: HandoffDiagnosticCode;
  readonly issues?: readonly HandoffValidationIssue[];

  constructor(
    code: HandoffDiagnosticCode,
    path: string,
    message: string,
    options: Readonly<{
      cause?: unknown;
      issues?: readonly HandoffValidationIssue[];
    }> = {},
  ) {
    super(code, path, message, options);
    this.name = "HandoffError";
    if (options.issues !== undefined) {
      this.issues = Object.freeze(
        options.issues.map((issue) =>
          Object.freeze({ path: issue.path, message: issue.message }),
        ),
      );
    }
  }
}

export function failHandoffWithIssues(
  code: HandoffDiagnosticCode,
  path: string,
  message: string,
  issues: readonly HandoffValidationIssue[],
): never {
  throw new HandoffError(code, path, message, { issues });
}

export function failHandoff(
  code: HandoffDiagnosticCode,
  path: string,
  message: string,
  cause?: unknown,
): never {
  throw new HandoffError(
    code,
    path,
    message,
    cause === undefined ? {} : { cause },
  );
}
