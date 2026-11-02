import type { AnyInteractionDefinition, DefinitionErrors } from "@foxworth/boundary";
import type { InteractionHandle, SurfaceHandle } from "@foxworth/boundary/pipeline";
import type { HandoffValidationIssue } from "@foxworth/boundary/handoff";
import { BoundaryErrorBase, type JsonValue, type Sha256Digest } from "@foxworth/boundary/program";

export type AdapterDiagnosticCode =
  | "INVALID_DECLARATION"
  | "DUPLICATE_DECLARATION"
  | "INTERACTION_NOT_EXPOSED"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_SCHEMA"
  | "SCHEMA_MISMATCH"
  | "STALE_BINDING"
  | "STALE_CONTRACT"
  | "STALE_REFERENCE"
  | "TRANSPORT_FAILURE"
  | "REMOTE_EXECUTION_FAILED";

export class AdapterError extends BoundaryErrorBase {
  declare readonly code: AdapterDiagnosticCode;

  constructor(
    code: AdapterDiagnosticCode,
    path: string,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(code, path, message, options);
    // Local diagnostics must not become enumerable wire data.
    Object.defineProperty(this, "cause", { enumerable: false });
    this.name = "AdapterError";
  }
}

/** A validated server diagnostic proving dispatch did not begin. */
export class RemoteProtocolRejection extends AdapterError {
  readonly certainty = "not-started" as const;
  readonly status: 400 | 409;
  readonly remoteCode: string;

  constructor(
    status: 400 | 409,
    remoteCode: string,
    path: string,
  ) {
    super(
      status === 409 ? "STALE_BINDING" : "INVALID_REQUEST",
      path,
      `the remote protocol rejected the invocation: ${remoteCode}`,
    );
    this.name = "RemoteProtocolRejection";
    this.status = status;
    this.remoteCode = remoteCode;
  }
}

type DefinitionOf<Handle> = Handle extends SurfaceHandle<
  InteractionHandle<infer Definition>,
  any
> ? Definition : AnyInteractionDefinition;

export type InteractionDeclaredError<Handle> = DefinitionErrors<
  DefinitionOf<Handle>
> extends infer Errors extends Readonly<Record<string, JsonValue>>
  ? {
      [Code in keyof Errors & string]: Readonly<{
        code: Code;
        details: Errors[Code];
      }>;
    }[keyof Errors & string]
  : never;

export class RemoteDomainError<Value extends Readonly<{
  code: string;
  details: JsonValue;
}> = Readonly<{ code: string; details: JsonValue }>> extends BoundaryErrorBase {
  declare readonly code: "REMOTE_DOMAIN_ERROR";
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly value: Value;

  constructor(
    interactionId: string,
    expectedContractDigest: Sha256Digest,
    value: Value,
  ) {
    super("REMOTE_DOMAIN_ERROR", `${interactionId}.error`, "the interaction returned a declared domain error");
    this.name = "RemoteDomainError";
    this.interactionId = interactionId;
    this.expectedContractDigest = expectedContractDigest;
    this.value = value;
  }
}

export type RemoteInteractionDomainError<Handle> = RemoteDomainError<
  InteractionDeclaredError<Handle>
>;

export function isDomainErrorFor<Handle extends {
  readonly interactionId: string;
  readonly contractDigest: Sha256Digest;
}>(
  handle: Handle,
  error: unknown,
): error is RemoteInteractionDomainError<Handle> {
  return error instanceof RemoteDomainError
    && error.interactionId === handle.interactionId
    && error.expectedContractDigest === handle.contractDigest;
}

/** The invocation crossed the dispatch boundary, so its consequence is unknown. */
export class RemoteInvocationError extends BoundaryErrorBase {
  declare readonly code: "REMOTE_INVOCATION_FAILED";
  readonly certainty = "unknown" as const;
  readonly phase: "transport" | "response";

  constructor(
    phase: "transport" | "response",
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super("REMOTE_INVOCATION_FAILED", "transport.invoke", message, options);
    Object.defineProperty(this, "cause", { enumerable: false });
    this.name = "RemoteInvocationError";
    this.phase = phase;
  }
}

export class RemoteProtocolError extends BoundaryErrorBase {
  readonly certainty: string;

  constructor(code: string, path: string, message: string, certainty = "not-started") {
    super(code, path, message);
    this.name = "RemoteProtocolError";
    this.certainty = certainty;
  }
}

export class RemoteExecutionError extends BoundaryErrorBase {
  declare readonly code: "REMOTE_EXECUTION_FAILED";
  readonly certainty: string;
  override readonly cause: string;
  readonly issues?: readonly HandoffValidationIssue[];

  constructor(
    path: string,
    certainty: string,
    cause: string,
    issues?: readonly HandoffValidationIssue[],
  ) {
    super("REMOTE_EXECUTION_FAILED", path, "the interaction could not be completed");
    this.name = "RemoteExecutionError";
    this.certainty = certainty;
    this.cause = cause;
    if (issues !== undefined) {
      this.issues = Object.freeze(
        issues.map((issue) =>
          Object.freeze({ path: issue.path, message: issue.message }),
        ),
      );
    }
  }
}

export type RemoteInteractionError<Handle> =
  | RemoteInteractionDomainError<Handle>
  | RemoteProtocolError
  | RemoteExecutionError
  | RemoteInvocationError
  | RemoteProtocolRejection
  | AdapterError;
