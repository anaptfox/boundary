import { hashJson, normalizeJson, isInteractionId, type JsonObject } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { PLAN_DOMAIN, PlanError, type Plan, type PlanInputBinding, type PlanSource, type PlanStep } from "./types";

const stepPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const aliasPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const fail = (code: ConstructorParameters<typeof PlanError>[0], path: string, message: string): never => { throw new PlanError(code, path, message); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function freezeJson(value: unknown, path: string): any {
  const normalized = normalizeJson(value, path);
  const freeze = (item: any): any => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(normalized);
}

function normalizeBinding(value: unknown, path: string): PlanInputBinding {
  if (!object(value)) return fail("INVALID_STEP", path, "binding must be an object");
  if (value.kind === "literal") {
    if (!Object.hasOwn(value, "value")) return fail("INVALID_STEP", path, "literal binding requires value");
    return Object.freeze({ kind: "literal", value: freezeJson(value.value, `${path}.value`) });
  }
  if (value.kind === "plan-input" && typeof value.path === "string") return Object.freeze({ kind: "plan-input", path: value.path });
  if (value.kind === "step-output" && typeof value.stepId === "string") {
    if (value.path !== undefined && typeof value.path !== "string") return fail("INVALID_STEP", path, "step-output path must be a string");
    return Object.freeze(value.path === undefined ? { kind: "step-output", stepId: value.stepId } : { kind: "step-output", stepId: value.stepId, path: value.path });
  }
  if (value.kind === "step-output" && typeof value.step_id === "string") {
    if (value.path !== undefined && typeof value.path !== "string") return fail("INVALID_STEP", path, "step-output path must be a string");
    return Object.freeze(value.path === undefined ? { kind: "step-output", stepId: value.step_id } : { kind: "step-output", stepId: value.step_id, path: value.path });
  }
  return fail("INVALID_STEP", path, "unknown or malformed input binding");
}

function normalizeSteps(value: unknown): readonly PlanStep[] {
  if (!Array.isArray(value) || value.length === 0) return fail("INVALID_PLAN", "steps", "plan requires at least one step");
  const ids = new Set<string>(), aliases = new Map<string, string>(), interactionAliases = new Map<string, string>();
  const steps = value.map((raw, index): PlanStep => {
    const path = `steps[${index}]`;
    if (!object(raw)) return fail("INVALID_STEP", path, "step must be an object");
    const { id, alias, interactionId, mode } = raw;
    if (typeof id !== "string" || !stepPattern.test(id)) return fail("INVALID_STEP", `${path}.id`, "step id must match the ASCII identifier pattern");
    if (ids.has(id)) return fail("DUPLICATE_STEP_ID", `${path}.id`, `duplicate step id ${id}`);
    ids.add(id);
    if (typeof alias !== "string" || !aliasPattern.test(alias)) return fail("INVALID_STEP", `${path}.alias`, "invalid projection alias");
    if (typeof interactionId !== "string" || !isInteractionId(interactionId)) return fail("INVALID_STEP", `${path}.interactionId`, "invalid interaction id");
    if (mode !== "direct" && mode !== "request") return fail("INVALID_STEP", `${path}.mode`, "mode must be direct or request");
    const knownInteraction = aliases.get(alias), knownAlias = interactionAliases.get(interactionId);
    if (knownInteraction !== undefined && knownInteraction !== interactionId) return fail("ALIAS_CONFLICT", `${path}.alias`, `alias ${alias} maps to multiple interactions`);
    if (knownAlias !== undefined && knownAlias !== alias) return fail("ALIAS_CONFLICT", `${path}.interactionId`, `interaction ${interactionId} maps to multiple aliases`);
    aliases.set(alias, interactionId); interactionAliases.set(interactionId, alias);
    const inputsRaw = raw.inputs ?? {};
    if (!object(inputsRaw)) return fail("INVALID_STEP", `${path}.inputs`, "inputs must be an object");
    const inputs: Record<string, PlanInputBinding> = Object.create(null);
    for (const key of Object.keys(inputsRaw).sort(compareUtf8)) inputs[key] = normalizeBinding(inputsRaw[key], `${path}.inputs.${key}`);
    const dependencies = raw.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((entry) => typeof entry !== "string")) return fail("INVALID_STEP", `${path}.dependsOn`, "dependsOn must be an array of step ids");
    return Object.freeze({ id, alias, interactionId, mode, inputs: Object.freeze(inputs), dependsOn: Object.freeze([...new Set(dependencies as string[])].sort(compareUtf8)) });
  });
  const byId = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.dependsOn) if (!byId.has(dependency)) fail("UNKNOWN_STEP", `steps.${step.id}.dependsOn`, `unknown step ${dependency}`);
    for (const [name, binding] of Object.entries(step.inputs)) if (binding.kind === "step-output" && !byId.has(binding.stepId)) fail("UNKNOWN_STEP", `steps.${step.id}.inputs.${name}`, `unknown step ${binding.stepId}`);
  }
  const graph = steps.map((step) => new Set([...step.dependsOn, ...Object.values(step.inputs).flatMap((binding) => binding.kind === "step-output" ? [binding.stepId] : [])]));
  const state = new Map<string, number>();
  const visit = (id: string): void => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) fail("CYCLE_DETECTED", `steps.${id}`, "dependency graph contains a cycle");
    if (mark === 2) return;
    state.set(id, 1);
    for (const dependency of graph[steps.findIndex((item) => item.id === id)]!) visit(dependency);
    state.set(id, 2);
  };
  for (const step of steps) visit(step.id);
  steps.sort((left, right) => compareUtf8(left.id, right.id));
  return Object.freeze(steps);
}

function build(id: string, steps: readonly PlanStep[]): Plan {
  if (typeof id !== "string" || id.length === 0) return fail("INVALID_PLAN", "id", "plan id must be a non-empty string");
  const body = Object.freeze({ version: 1 as const, id, steps });
  const canonicalSteps = steps.map((step) => ({
    ...step,
    inputs: Object.fromEntries(Object.entries(step.inputs).map(([name, binding]) => [
      name,
      binding.kind === "step-output"
        ? { kind: binding.kind, step_id: binding.stepId, ...(binding.path === undefined ? {} : { path: binding.path }) }
        : binding,
    ])),
  }));
  const planDigest = hashJson(PLAN_DOMAIN, { ...body, steps: canonicalSteps } as unknown as JsonObject);
  return Object.freeze({ ...body, planDigest });
}

export function createPlan(source: PlanSource): Plan {
  if (!object(source)) return fail("INVALID_PLAN", "plan", "source must be an object");
  return build(source.id, normalizeSteps(source.steps));
}

export function validatePlan(value: unknown): Plan {
  if (!object(value) || value.version !== 1 || typeof value.id !== "string" || typeof value.planDigest !== "string") return fail("INVALID_PLAN", "plan", "invalid Plan envelope");
  const plan = build(value.id, normalizeSteps(value.steps));
  if (plan.planDigest !== value.planDigest) return fail("PLAN_DIGEST_MISMATCH", "planDigest", "plan digest does not match normalized plan");
  return plan;
}
