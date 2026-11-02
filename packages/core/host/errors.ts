import { BoundaryErrorBase, type InvocationCertainty, type JsonValue } from "@foxworth/boundary/program";

export type HostDiagnosticCode =
  | "INVALID_DECLARATION"
  | "INVALID_DEFINITION_COLLECTION"
  | "FORGED_DEFINITION"
  | "DUPLICATE_INTERACTION_ID"
  | "DUPLICATE_INTERACTION_ALIAS"
  | "INVALID_IMPLEMENTATION"
  | "IMPLEMENTATION_COVERAGE_MISMATCH"
  | "FOREIGN_IMPLEMENTATIONS"
  | "INVALID_INSTALLATION_ID"
  | "INVALID_REALIZATION_ID"
  | "INVALID_INSTALLATION"
  | "FOREIGN_HANDLE"
  | "DUPLICATE_REALIZATION"
  | "REALIZATION_COVERAGE_MISMATCH"
  | "INVALID_REQUEST_BINDING"
  | "INVALID_PROJECTION"
  | "INVALID_SURFACE"
  | "DUPLICATE_PROJECTION_INTERACTION"
  | "INVALID_ADMISSION"
  | "INVALID_DECLARED_ERROR"
  | "INVALID_INVOCATION"
  | "INVALID_ARTIFACT"
  | "INVALID_ARTIFACT_PATH"
  | "INVALID_ARTIFACT_DESTINATION"
  | "INVALID_INTERACTION_MODULE";

export class HostError extends BoundaryErrorBase {
  declare readonly code: HostDiagnosticCode;

  constructor(
    code: HostDiagnosticCode,
    path: string,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(code, path, message, options);
    this.name = "HostError";
  }
}

/** A thrown fault's certainty: any {@link InvocationCertainty} but `completed`. */
export type InteractionFaultCertainty = Exclude<InvocationCertainty, "completed">;

export type InteractionFaultCause =
  | "invalid-input"
  | "denied"
  | "admission-failed"
  | "revoked"
  | "invalid-realization-outcome"
  | "realization-failed"
  | "request-failed"
  | "invalid-invocation";

export class InteractionFault extends Error {
  readonly certainty: InteractionFaultCertainty;
  override readonly cause: InteractionFaultCause;
  readonly details: JsonValue | undefined;

  constructor(
    cause: InteractionFaultCause,
    certainty: InteractionFaultCertainty,
    message: string,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "InteractionFault";
    this.cause = cause;
    this.certainty = certainty;
    this.details = details;
  }
}

export function failHost(
  code: HostDiagnosticCode,
  path: string,
  message: string,
  cause?: unknown,
): never {
  throw new HostError(code, path, message, cause === undefined ? {} : { cause });
}
