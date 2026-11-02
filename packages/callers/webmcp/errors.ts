import { BoundaryErrorBase } from "@foxworth/boundary/program";

export type WebMcpDiagnosticCode =
  | "UNSUPPORTED_HOST"
  | "INVALID_TOOL"
  | "DUPLICATE_NAME"
  | "REGISTRATION_FAILED"
  | "INCOMPATIBLE_LIVE_REPLACEMENT"
  | "DISPOSED_REGISTRATION";

export class WebMcpError extends BoundaryErrorBase {
  declare readonly code: WebMcpDiagnosticCode;

  constructor(code: WebMcpDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "WebMcpError";
  }
}
