import { cloneJson } from "@foxworth/boundary/program";
import { controlError } from "./errors";
import type { ControlEffect, ControlPlan, ControlSubject } from "./types";

function normalizeSubject(subject: ControlSubject, path: string): ControlSubject {
  if (!subject?.kind?.trim() || !subject?.id?.trim()) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      `${path}.subject`,
      "subject kind and id are required",
    );
  }
  return Object.freeze({ kind: subject.kind, id: subject.id });
}

function normalizeEffect(effect: ControlEffect, path: string): ControlEffect {
  if (
    !effect?.kind?.trim() ||
    !effect?.action?.trim() ||
    !effect?.resource?.trim()
  ) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      path,
      "effect kind, action, and resource are required",
    );
  }
  return Object.freeze({
    kind: effect.kind,
    action: effect.action,
    resource: effect.resource,
    ...(effect.description === undefined
      ? {}
      : { description: effect.description }),
    ...(effect.details === undefined
      ? {}
      : { details: cloneJson(effect.details, `${path}.details`) }),
  });
}

export function normalizeControlPlan(
  plan: ControlPlan,
  path: string,
): ControlPlan {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      path,
      "plan must be an object",
    );
  }
  if (!plan.baselineSummary?.trim()) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      `${path}.baselineSummary`,
      "baselineSummary is required",
    );
  }
  if (!Array.isArray(plan.effects) || plan.effects.length === 0) {
    throw controlError(
      "CONTROL_INVALID_PLAN",
      `${path}.effects`,
      "at least one effect is required",
    );
  }
  return Object.freeze({
    subject: normalizeSubject(plan.subject, path),
    baseline: cloneJson(plan.baseline, `${path}.baseline`),
    baselineSummary: plan.baselineSummary,
    effects: Object.freeze(
      plan.effects.map((effect, index) =>
        normalizeEffect(effect, `${path}.effects[${index}]`),
      ),
    ),
    state: cloneJson(plan.state, `${path}.state`),
    preview: cloneJson(plan.preview, `${path}.preview`),
  });
}
