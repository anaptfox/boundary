import { contractCompatibility } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { PlanError, type Plan, type PlanFootprints, type PlanRequiredSelections } from "./types";
import { projectInteractions, type CompiledInteractions, type Projection } from "@foxworth/boundary";
import type { Program, InteractionMode } from "@foxworth/boundary/program";

function contracts(plan: Plan, program: Program) {
  const map = new Map(program.interactions.map((interaction) => [interaction.contract.id, interaction.contract]));
  return plan.steps.map((step) => {
    const contract = map.get(step.interactionId);
    if (!contract) throw new PlanError("MISSING_INTERACTION", `steps.${step.id}`, `interaction ${step.interactionId} is absent from Program`);
    return { step, contract };
  });
}

export function planAggregateFootprints(plan: Plan, program: Program): PlanFootprints {
  const values = contracts(plan, program);
  return Object.freeze({
    reads: Object.freeze([...new Set(values.flatMap(({ contract }) => contract.reads))].sort(compareUtf8)),
    changes: Object.freeze([...new Set(values.flatMap(({ contract }) => contract.changes))].sort(compareUtf8)),
  });
}

export function planParallelWaves(plan: Plan, program: Program): readonly (readonly string[])[] {
  const values = contracts(plan, program);
  const waveById = new Map<string, number>(), pending = [...values];
  while (pending.length > 0) {
    const readyIndex = pending.findIndex(({ step }) => [...step.dependsOn, ...Object.values(step.inputs).flatMap((binding) => binding.kind === "step-output" ? [binding.stepId] : [])].every((id) => waveById.has(id)));
    if (readyIndex < 0) throw new PlanError("CYCLE_DETECTED", "steps", "dependency graph contains a cycle");
    const [item] = pending.splice(readyIndex, 1);
    const dependencies = new Set([...item!.step.dependsOn, ...Object.values(item!.step.inputs).flatMap((binding) => binding.kind === "step-output" ? [binding.stepId] : [])]);
    let wave = 0;
    for (const dependency of dependencies) wave = Math.max(wave, waveById.get(dependency)! + 1);
    const reads = new Set(item!.contract.reads), writes = new Set(item!.contract.changes);
    for (const before of values.filter(({ step }) => waveById.has(step.id))) {
      const priorWave = waveById.get(before.step.id)!;
      if (priorWave < wave) continue;
      const conflict = before.contract.changes.some((key) => reads.has(key) || writes.has(key)) || item.contract.changes.some((key) => before.contract.reads.includes(key));
      if (conflict) wave = Math.max(wave, priorWave + 1);
    }
    waveById.set(item!.step.id, wave);
  }
  const waves: string[][] = [];
  for (const item of values) (waves[waveById.get(item.step.id)!] ??= []).push(item.step.id);
  return Object.freeze(waves.map((wave) => Object.freeze(wave)));
}

export function planRequiredSelections(plan: Plan, program: Program): PlanRequiredSelections {
  contracts(plan, program);
  const selections: Record<string, { interactionId: string; modes: InteractionMode[] }> = Object.create(null);
  for (const step of plan.steps) {
    const entry = selections[step.alias] ??= { interactionId: step.interactionId, modes: [] };
    if (!entry.modes.includes(step.mode)) entry.modes.push(step.mode);
  }
  for (const entry of Object.values(selections)) entry.modes.sort(compareUtf8);
  return Object.freeze(Object.fromEntries(Object.entries(selections).sort(([a], [b]) => compareUtf8(a, b)).map(([key, value]) => [key, Object.freeze({ interactionId: value.interactionId, modes: Object.freeze(value.modes) })])));
}

export function planRequiredProjection(plan: Plan, compiled: CompiledInteractions<any>): Projection<any> {
  const selections = planRequiredSelections(plan, compiled.program);
  const selected: Record<string, { interaction: unknown; modes: readonly string[] }> = Object.create(null);
  for (const [alias, selection] of Object.entries(selections)) {
    const handle = (compiled.handles as Record<string, { interactionId?: string }>)[alias];
    if (!handle || handle.interactionId !== selection.interactionId) throw new PlanError("MISSING_INTERACTION", `aliases.${alias}`, `compiled alias ${alias} does not identify ${selection.interactionId}`);
    selected[alias] = { interaction: handle, modes: selection.modes };
  }
  return projectInteractions(compiled, selected as any);
}

export { contractCompatibility };
