import {
  contractCompatibility,
  normalizeJson,
  interactionContractIdentity,
  validateCatalog,
  isSha256Digest,
  type Program,
  type InteractionContract,
  type InstallationManifest,
  type SurfaceManifest,
  type SurfaceInteraction,
} from "@foxworth/boundary/program";
import type { UnrealizedIssue } from "./types";

/** Data-only check shared by live construction and candidate assessment. */
export function assessInteraction(
  selection: SurfaceInteraction,
  expected: InteractionContract,
  actual: Readonly<{
    contract: InteractionContract;
    inputArity?: 0 | 1;
    direct: boolean;
    request: boolean;
  }> | undefined,
  revoked = false,
): readonly UnrealizedIssue[] {
  const issue = (reason: UnrealizedIssue["reason"], message: string): UnrealizedIssue =>
    Object.freeze({ alias: selection.alias, interactionId: selection.interactionId, reason, message });
  if (revoked) return [issue("installation-revoked", "the Installation has been revoked")];
  if (!actual) return [issue("missing-interaction", "the Installation does not realize this interaction")];
  const compatibility = contractCompatibility(expected, actual.contract);
  if (!compatibility.compatible) {
    return [issue("incompatible-contract", `${compatibility.reason} at ${compatibility.path}`)];
  }
  if (actual.inputArity !== undefined && selection.inputArity !== actual.inputArity) {
    return [issue("incompatible-arity", "expected and actual input arities differ")];
  }
  return selection.modes.flatMap((mode) => actual[mode] ? [] : [Object.freeze({
    ...issue(mode === "direct" ? "missing-direct" : "missing-request", `the Installation does not realize ${mode} mode`),
    mode,
  })]);
}

function validateCandidateProgram(program: Program): void {
  if (program.version !== 1 || !isSha256Digest(program.programDigest) || !Array.isArray(program.interactions)) {
    throw new TypeError("Candidate Program must have version 1, a digest, and interactions");
  }
  const ids = new Set<string>();
  for (const descriptor of program.interactions) {
    if (descriptor.version !== 1 || !isSha256Digest(descriptor.contractDigest)) {
      throw new TypeError("Candidate descriptor must have version 1 and a contract digest");
    }
    interactionContractIdentity(descriptor.contract);
    if (ids.has(descriptor.contract.id)) throw new TypeError("Duplicate candidate interaction ID");
    ids.add(descriptor.contract.id);
  }
}

export type SurfaceAssessment = Readonly<{
  status: "fit" | "mismatch";
  issues: readonly UnrealizedIssue[];
  missingEvidence: readonly ("artifact-authenticity" | "actual-input-arity" | "live-revocation" | "admission")[];
}>;

/**
 * Compare the declarations and availability claimed by candidate manifests.
 * This does not authenticate artifacts, construct a Binding, or grant a call.
 */
export function assessSurface(
  projection: SurfaceManifest,
  installation: InstallationManifest,
): SurfaceAssessment {
  // Own the input before interpreting it; caller mutation/accessors cannot race a check.
  const desired = normalizeJson(projection) as unknown as SurfaceManifest;
  const candidate = normalizeJson(installation) as unknown as InstallationManifest;
  if (desired.version !== 1 || candidate.version !== 1 ||
      !isSha256Digest(desired.projectionDigest) || !isSha256Digest(candidate.installationDigest) ||
      typeof candidate.installationId !== "string" || candidate.installationId.length === 0 ||
      !Array.isArray(desired.interactions)) {
    throw new TypeError("Candidate manifests require version 1, identities, and projection interactions");
  }
  validateCandidateProgram(desired.program);
  validateCandidateProgram(candidate.program);
  validateCatalog(candidate.program, candidate.catalog);
  const aliases = new Set<string>();
  const selectedIds = new Set<string>();
  for (const selection of desired.interactions) {
    if (typeof selection.alias !== "string" || selection.alias.length === 0 ||
        aliases.has(selection.alias) || selectedIds.has(selection.interactionId) ||
        !isSha256Digest(selection.expectedContractDigest) ||
        (selection.inputArity !== 0 && selection.inputArity !== 1) ||
        !Array.isArray(selection.modes) || selection.modes.length === 0 ||
        new Set(selection.modes).size !== selection.modes.length ||
        selection.modes.some((mode: unknown) => mode !== "direct" && mode !== "request")) {
      throw new TypeError("Invalid or duplicate candidate CompiledSurface selection");
    }
    aliases.add(selection.alias);
    selectedIds.add(selection.interactionId);
  }
  const expected = new Map(desired.program.interactions.map((item) => [item.contract.id, item]));
  const actual = new Map(candidate.program.interactions.map((item) => [item.contract.id, item]));
  const availability = new Map(candidate.catalog.interactions.map((item) => [item.interactionId, item]));
  const issues = desired.interactions.flatMap((selection) => {
    const declared = expected.get(selection.interactionId);
    if (!declared) throw new TypeError(`CompiledSurface has no declaration for ${selection.interactionId}`);
    if (selection.expectedContractDigest !== declared.contractDigest) {
      throw new TypeError("CompiledSurface selection digest differs from its declaration");
    }
    const realized = actual.get(selection.interactionId);
    const modes = availability.get(selection.interactionId);
    return assessInteraction(selection, declared.contract, realized && modes ? {
      contract: realized.contract,
      direct: modes.direct !== undefined,
      request: modes.request !== undefined,
    } : undefined);
  });
  return Object.freeze({
    status: issues.length === 0 ? "fit" : "mismatch",
    issues: Object.freeze(issues),
    missingEvidence: Object.freeze([
      "artifact-authenticity", "actual-input-arity", "live-revocation", "admission",
    ] as const),
  });
}
