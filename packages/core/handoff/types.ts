import type {
  InstallationId,
  JsonValue,
  InteractionMode,
  BindingManifest,
  RawInvocationOutcome,
  RealizationId,
  InvocationCertainty,
  Sha256Digest,
} from "@foxworth/boundary/program";

/** Stable public causes. Native exception messages and properties never cross. */
export type HandoffFaultCause =
  | "invalid-input"
  | "revoked"
  | "admission-failed"
  | "request-failed"
  | "invalid-realization-outcome"
  | "realization-failed"
  | "invalid-invocation";

/** Portable, non-secret input-validation evidence safe to cross the wire. */
export type HandoffValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

export interface HandoffInvocation<
  Input extends JsonValue = JsonValue,
> {
  readonly version: 1;
  readonly bindingDigest: Sha256Digest;
  readonly installationId: InstallationId;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly mode: InteractionMode;
  readonly realizationId: RealizationId;
  readonly input: Input;
}

export type HandoffResult =
  | Readonly<{ kind: "returned"; value: JsonValue }>
  | Readonly<{
      kind: "declared-error";
      code: string;
      details: JsonValue;
    }>
  | Readonly<{ kind: "proposed"; proposal: JsonValue }>
  | Readonly<{ kind: "denied"; code: string }>
  | Readonly<{
      kind: "fault";
      cause: HandoffFaultCause;
      issues?: readonly HandoffValidationIssue[];
    }>;

export interface HandoffOutcome {
  readonly version: 1;
  readonly bindingDigest: Sha256Digest;
  readonly installationId: InstallationId;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly actualContractDigest: Sha256Digest;
  readonly mode: InteractionMode;
  readonly realizationId: RealizationId;
  readonly certainty: InvocationCertainty;
  readonly result: HandoffResult;
}

export type HandoffResolvedInteraction = Readonly<{
  interactionId: string;
  inputArity: 0 | 1;
  modes: readonly Readonly<{
    mode: InteractionMode;
    realizationId: RealizationId;
    expectedContractDigest: Sha256Digest;
    actualContractDigest: Sha256Digest;
  }>[];
}>;

export type HandoffBindingInvocation = Readonly<{
  interaction: HandoffResolvedInteraction;
  mode: InteractionMode;
  input: unknown;
}>;

/** Live Binding seam Handoff needs. A structural copy so Handoff never imports Host; `tests/typescript/handoff-host-seam.test.ts` proves Host's Binding satisfies it. */
export interface HandoffExecutable {
  readonly manifest: BindingManifest;
  resolve(interactionId: string): HandoffResolvedInteraction | undefined;
  invoke(...args: any[]): Promise<RawInvocationOutcome>;
}

export interface CheckedHandoff<Context = unknown> {
  readonly manifest: BindingManifest;
  invoke(
    invocation: HandoffInvocation,
    context: Context,
  ): Promise<HandoffOutcome>;
}
