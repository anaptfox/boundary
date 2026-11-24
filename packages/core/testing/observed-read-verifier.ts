import { jsonEquals, type JsonValue } from "@foxworth/boundary/program";

export type DifferentialStep<Context = unknown> = Readonly<{ kind: "read"; context: Context; label?: string } | { kind: "mutate"; context: Context; label?: string }>;
export type ObservedReadMismatch = Readonly<{ step: number; label?: string; cached: JsonValue; fresh: JsonValue }>;
export type ObservedReadDifferentialReport = Readonly<{ ok: boolean; readsChecked: number; mismatches: readonly ObservedReadMismatch[] }>;

export async function verifyObservedReadEquivalence<Context>(options: {
  steps: readonly DifferentialStep<Context>[];
  runCached: (step: DifferentialStep<Context>) => Promise<JsonValue>;
  runFresh: (step: DifferentialStep<Context>) => Promise<JsonValue>;
  mutate?: (step: DifferentialStep<Context>) => Promise<void>;
}): Promise<ObservedReadDifferentialReport> {
  const mismatches: ObservedReadMismatch[] = [];
  let readsChecked = 0;
  for (let i = 0; i < options.steps.length; i++) {
    const step = options.steps[i]!;
    if (step.kind === "mutate") { await options.mutate?.(step); continue; }
    const [cached, fresh] = await Promise.all([options.runCached(step), options.runFresh(step)]);
    readsChecked++;
    if (!jsonEquals(cached, fresh)) mismatches.push(Object.freeze({ step: i, ...(step.label ? { label: step.label } : {}), cached, fresh }));
  }
  return Object.freeze({ ok: mismatches.length === 0, readsChecked, mismatches: Object.freeze(mismatches) });
}
