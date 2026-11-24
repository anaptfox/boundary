import { contractCompatibility, type Program, type ProjectionBindingManifest } from "@foxworth/boundary/program";
import type { ProjectionBinding } from "@foxworth/boundary";
import { PlanError, type Plan, type PreflightIssue, type PreflightReport } from "./types";

export function preflightPlan(
  plan: Plan,
  target: ProjectionBinding<any, any> | ProjectionBindingManifest,
  expectedProgram?: Program,
): PreflightReport {
  const manifest = "manifest" in target ? target.manifest : target;
  if (!manifest || !Array.isArray(manifest.interactions)) throw new PlanError("INVALID_PLAN", "target", "target must provide a binding manifest");
  const issues: PreflightIssue[] = [];
  const revoked = "manifest" in target && ((target as any).revoked === true || (target as any).controller?.revoked === true);
  for (const step of plan.steps) {
    const sameAlias = manifest.interactions.filter((entry) => entry.alias === step.alias);
    const exact = sameAlias.find((entry) => entry.interactionId === step.interactionId);
    const issue = (reason: PreflightIssue["reason"], message: string) => issues.push(Object.freeze({ stepId: step.id, alias: step.alias, interactionId: step.interactionId, reason, message }));
    if (revoked) issue("binding-revoked", "binding has been revoked");
    if (sameAlias.length === 0) {
      issue("missing-interaction", `alias ${step.alias} is not bound`);
      continue;
    }
    if (!exact) {
      issue("alias-mismatch", `alias ${step.alias} is bound to a different interaction`);
      continue;
    }
    if (exact.mode !== step.mode) issue("mode-not-bound", `mode ${step.mode} is not bound for alias ${step.alias}`);
    if (expectedProgram) {
      const expected = expectedProgram.interactions.find((entry) => entry.contract.id === step.interactionId)?.contract;
      const actual = manifest.actualProgram.interactions.find((entry) => entry.contract.id === exact.interactionId)?.contract;
      if (!expected || !actual || !contractCompatibility(expected, actual).compatible) {
        const compatibility = expected && actual ? contractCompatibility(expected, actual) : undefined;
        issue("contract-mismatch", !expected ? "expected Program lacks the interaction contract" : !actual ? "binding Program lacks the actual interaction contract" : `bound contract is incompatible: ${compatibility && !compatibility.compatible ? compatibility.reason : "unknown incompatibility"}`);
      }
    }
  }
  return Object.freeze({ ready: issues.length === 0, planDigest: plan.planDigest, bindingDigest: manifest.bindingDigest, issues: Object.freeze(issues) });
}
