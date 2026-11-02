import type { InteractionMode, BindingManifest, BindingInteraction } from "@foxworth/boundary/program";
import { isInteractionId, isSha256Digest, validateSchemaValue, type JsonValue, type InteractionDescriptor, type SchemaValueIssue } from "@foxworth/boundary/program";
import { exactObject, snapshotJson } from "#program/internal";
import { failHandoff, failHandoffWithIssues } from "./errors";
import type { HandoffFaultCause, HandoffInvocation, HandoffValidationIssue } from "./types";

type ManifestIndex = Readonly<{
  interactions: ReadonlyMap<string, ReadonlyMap<InteractionMode, BindingInteraction>>;
  expected: ReadonlyMap<string, InteractionDescriptor>;
  actual: ReadonlyMap<string, InteractionDescriptor>;
}>;

// Index only owned, validated snapshots. Raw caller manifests must still be
// snapshotted and checked before any derived lookup can be reused.
export const validatedManifests = new WeakMap<object, ManifestIndex>();

export const validatedInvocations = new WeakSet<object>();

export const BINDING_DOMAIN = "boundary.projection-binding/v1";

export const PROJECTION_DOMAIN = "boundary.projection/v1";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u;

export const ALIAS = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export const FAULT_CAUSES = new Set<HandoffFaultCause>([
  "invalid-input",
  "revoked",
  "admission-failed",
  "request-failed",
  "invalid-realization-outcome",
  "realization-failed",
  "invalid-invocation",
]);

export function malformed(path: string, message: string, cause?: unknown): never {
  return failHandoff("INVALID_MANIFEST", path, message, cause);
}

function invocationFailure(path: string, message: string): never {
  return failHandoff("INVALID_INVOCATION", path, message);
}

export function outcomeFailure(path: string, message: string): never {
  return failHandoff("INVALID_OUTCOME", path, message);
}

export function exact(
  value: unknown,
  path: string,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
  kind: "manifest" | "invocation" | "outcome" = "manifest",
): Record<string, unknown> {
  const fail = (failure: Readonly<{ path: string; message: string }>): never => {
    if (kind === "invocation") {
      return invocationFailure(failure.path, failure.message);
    }
    if (kind === "outcome") {
      return outcomeFailure(failure.path, failure.message);
    }
    return malformed(failure.path, failure.message);
  };
  return exactObject(value, { path, keys, optionalKeys, fail });
}

export function snapshot(
  value: unknown,
  path: string,
  kind: "manifest" | "invocation" | "outcome",
): JsonValue {
  return snapshotJson(value, {
    path,
    fail(failure) {
      if (kind === "invocation") {
        return invocationFailure(failure.path, failure.message);
      }
      if (kind === "outcome") {
        return outcomeFailure(failure.path, failure.message);
      }
      return malformed(failure.path, failure.message);
    },
  });
}

export function requireVersion(value: unknown, path: string): asserts value is 1 {
  if (value !== 1) {
    failHandoff(
      "UNSUPPORTED_VERSION",
      path,
      "only Handoff protocol version 1 is accepted",
    );
  }
}

export function requireDigest(
  value: unknown,
  path: string,
  kind: "manifest" | "invocation" | "outcome",
): asserts value is `sha256:${string}` {
  if (isSha256Digest(value)) return;
  if (kind === "manifest") malformed(path, "digest must be sha256:<64 lowercase hex>");
  if (kind === "invocation") invocationFailure(path, "digest must be sha256:<64 lowercase hex>");
  outcomeFailure(path, "digest must be sha256:<64 lowercase hex>");
}

export function requireOpaqueId(
  value: unknown,
  path: string,
  kind: "manifest" | "invocation" | "outcome",
): asserts value is string {
  if (typeof value === "string" && OPAQUE_ID.test(value)) return;
  if (kind === "manifest") malformed(path, "identity must be a stable non-empty ASCII token");
  if (kind === "invocation") invocationFailure(path, "identity must be a stable non-empty ASCII token");
  outcomeFailure(path, "identity must be a stable non-empty ASCII token");
}

export function requireInteractionId(
  value: unknown,
  path: string,
  kind: "manifest" | "invocation" | "outcome",
): asserts value is string {
  if (isInteractionId(value)) return;
  if (kind === "manifest") malformed(path, "interactionId is invalid");
  if (kind === "invocation") invocationFailure(path, "interactionId is invalid");
  outcomeFailure(path, "interactionId is invalid");
}

export function requireMode(
  value: unknown,
  path: string,
  kind: "manifest" | "invocation" | "outcome",
): asserts value is InteractionMode {
  if (value === "direct" || value === "request") return;
  if (kind === "manifest") malformed(path, 'mode must be "direct" or "request"');
  if (kind === "invocation") invocationFailure(path, 'mode must be "direct" or "request"');
  outcomeFailure(path, 'mode must be "direct" or "request"');
}

export function descriptorById(
  interactions: readonly InteractionDescriptor[],
): ReadonlyMap<string, InteractionDescriptor> {
  return new Map(
    interactions.map((descriptor) => [descriptor.contract.id, descriptor]),
  );
}

export function interactionKey(interaction: BindingInteraction): string {
  return `${interaction.interactionId}\u0000${interaction.mode}`;
}

export function pinnedInteraction(
  manifest: BindingManifest,
  invocation: HandoffInvocation,
): BindingInteraction {
  if (invocation.bindingDigest !== manifest.bindingDigest) {
    failHandoff("STALE_BINDING", "invocation.bindingDigest", "invocation targets a different Binding");
  }
  if (invocation.installationId !== manifest.installationId) {
    failHandoff("STALE_INSTALLATION", "invocation.installationId", "invocation targets a different Installation");
  }
  const index = validatedManifests.get(manifest)!;
  const byInteraction = index.interactions.get(invocation.interactionId);
  if (!byInteraction) {
    failHandoff("INTERACTION_NOT_EXPOSED", "invocation.interactionId", "interaction is not exposed by this Binding");
  }
  const interaction = byInteraction.get(invocation.mode);
  if (!interaction) {
    failHandoff("MODE_NOT_EXPOSED", "invocation.mode", "mode is not exposed by this Binding");
  }
  if (
    invocation.expectedContractDigest !== interaction.expectedContractDigest ||
    invocation.actualContractDigest !== interaction.actualContractDigest
  ) {
    failHandoff("STALE_CONTRACT", "invocation.expectedContractDigest", "invocation contract pins do not match this Binding");
  }
  if (invocation.realizationId !== interaction.realizationId) {
    failHandoff("STALE_REALIZATION", "invocation.realizationId", "invocation targets a different realization");
  }
  if (interaction.inputArity === 0 && invocation.input !== null) {
    failHandoffWithIssues(
      "INVALID_INPUT",
      "invocation.input",
      "zero-arity interactions require the canonical null wire input",
      [
        Object.freeze({
          path: "invocation.input",
          message: "zero-arity interactions require the canonical null wire input",
        }),
      ],
    );
  }
  const expected = index.expected.get(invocation.interactionId)!;
  const actual = index.actual.get(invocation.interactionId)!;
  const issues = distinctIssues([
    ...validateSchemaValue(
      expected.contract.inputSchema,
      invocation.input,
      "invocation.input",
    ),
    ...validateSchemaValue(
      actual.contract.inputSchema,
      invocation.input,
      "invocation.input",
    ),
  ]);
  if (issues.length > 0) {
    failHandoffWithIssues(
      "INVALID_INPUT",
      issues[0]!.path,
      "input does not match both pinned contracts",
      issues,
    );
  }
  return interaction;
}

function distinctIssues(
  issues: readonly SchemaValueIssue[],
): readonly HandoffValidationIssue[] {
  const seen = new Set<string>();
  const result: HandoffValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ path: issue.path, message: issue.message }));
  }
  return Object.freeze(result);
}
