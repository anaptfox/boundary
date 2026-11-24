import { BoundaryErrorBase } from "./errors";

export type ProgramDiagnosticCode =
  | "INVALID_HASHER_RESULT"
  | "INVALID_INTERACTION_ID"
  | "INVALID_INTERACTION_FOOTPRINT"
  | "INVALID_FOOTPRINT"
  | "INVALID_CONTRACT_TRAIT"
  | "UNSUPPORTED_CONTRACT_VERSION"
  | "UNSUPPORTED_DESCRIPTOR_VERSION"
  | "UNSUPPORTED_PROGRAM_VERSION"
  | "EMPTY_READ"
  | "EMPTY_CHANGE"
  | "CONTRACT_DIGEST_MISMATCH"
  | "PROGRAM_DIGEST_MISMATCH"
  | "DUPLICATE_INTERACTION_ID"
  | "INVALID_DOCUMENTATION";

export class ProgramError extends BoundaryErrorBase {
  declare readonly code: ProgramDiagnosticCode;

  constructor(code: ProgramDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "ProgramError";
  }
}
