import { BoundaryErrorBase, type Program, type InteractionMode, type JsonValue, type Sha256Digest } from "@foxworth/boundary/program";

export const PLAN_DOMAIN = "boundary.plan/v1" as const;

export type PlanInputBinding =
  | Readonly<{ kind: "literal"; value: JsonValue }>
  | Readonly<{ kind: "plan-input"; path: string }>
  | Readonly<{ kind: "step-output"; stepId: string; path?: string }>;

export type PlanStep = Readonly<{
  id: string;
  alias: string;
  interactionId: string;
  mode: InteractionMode;
  inputs: Readonly<Record<string, PlanInputBinding>>;
  dependsOn: readonly string[];
}>;

export type Plan = Readonly<{
  version: 1;
  id: string;
  steps: readonly PlanStep[];
  planDigest: Sha256Digest;
}>;

export type PlanSource = Readonly<{
  id: string;
  steps: readonly Readonly<{
    id: string;
    alias: string;
    interactionId: string;
    mode: InteractionMode;
    inputs?: Readonly<Record<string, PlanInputBinding>>;
    dependsOn?: readonly string[];
  }>[];
}>;

export type PlanDiagnosticCode =
  | "INVALID_PLAN"
  | "INVALID_STEP"
  | "DUPLICATE_STEP_ID"
  | "UNKNOWN_STEP"
  | "ALIAS_CONFLICT"
  | "CYCLE_DETECTED"
  | "PLAN_DIGEST_MISMATCH"
  | "MISSING_INTERACTION";

export class PlanError extends BoundaryErrorBase {
  readonly code: PlanDiagnosticCode;
  constructor(code: PlanDiagnosticCode, path: string, message: string) {
    super(code, path, message);
    this.name = "PlanError";
    this.code = code;
  }
}

export type PlanFootprints = Readonly<{
  reads: readonly string[];
  changes: readonly string[];
}>;

export type PlanRequiredSelection = Readonly<{
  interactionId: string;
  modes: readonly InteractionMode[];
}>;
export type PlanRequiredSelections = Readonly<Record<string, PlanRequiredSelection>>;

export type PreflightIssueReason =
  | "missing-interaction"
  | "alias-mismatch"
  | "mode-not-bound"
  | "contract-mismatch"
  | "binding-revoked";
export type PreflightIssue = Readonly<{
  stepId: string;
  alias: string;
  interactionId: string;
  reason: PreflightIssueReason;
  message: string;
}>;
export type PreflightReport = Readonly<{
  ready: boolean;
  planDigest: Sha256Digest;
  bindingDigest: Sha256Digest;
  issues: readonly PreflightIssue[];
}>;

// Keeps the source shape discoverable from this leaf without importing runtime host code.
export type { Program };
