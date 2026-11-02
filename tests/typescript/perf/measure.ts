import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type BenchClass =
  | "startup"
  | "per-call"
  | "http"
  | "react"
  | "list";

export type BenchCase = Readonly<{
  id: string;
  lang: "ts" | "rust";
  class: BenchClass;
  iters: number;
  nsMedian: number;
  nsP95: number;
  warmup?: number;
  batchSize?: number;
  timingMode?: "async-single" | "sync-single" | "sync-batch";
  sampleUnit?: "ns";
  samplesNs?: readonly number[];
  statistic?: "single-call" | "batch-mean";
  extra?: Readonly<Record<string, number>>;
}>;

type Measurement = Pick<BenchCase, "iters" | "nsMedian" | "nsP95"> &
  Required<Pick<BenchCase,
    "warmup" | "batchSize" | "timingMode" | "sampleUnit" | "samplesNs" | "statistic"
  >>;

type MeasureOptions = Readonly<{
  warmup: number;
  iters: number;
  beforeEach?: () => unknown | Promise<unknown>;
}>;

function validateOptions(warmup: number, iters: number, batchSize: number): void {
  if (!Number.isSafeInteger(warmup) || warmup < 0 ||
      !Number.isSafeInteger(iters) || iters < 1 ||
      !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("measurement requires nonnegative warmup and positive iterations/batchSize");
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

export async function measure(
  fn: () => unknown | Promise<unknown>,
  options: MeasureOptions,
): Promise<Measurement> {
  validateOptions(options.warmup, options.iters, 1);
  for (let index = 0; index < options.warmup; index += 1) {
    if (options.beforeEach) await options.beforeEach();
    await fn();
  }
  const samples: number[] = [];
  for (let index = 0; index < options.iters; index += 1) {
    if (options.beforeEach) await options.beforeEach();
    const started = performance.now();
    await fn();
    samples.push((performance.now() - started) * 1e6);
  }
  return summarize(samples, options, 1, "async-single");
}

/** Each iteration times a batch; reported percentiles describe batch means. */
export function measureSync(
  fn: () => unknown,
  options: Readonly<{ warmup: number; iters: number; batchSize?: number; beforeEach?: () => void }>,
): Measurement {
  const batchSize = options.batchSize ?? 1;
  validateOptions(options.warmup, options.iters, batchSize);
  for (let index = 0; index < options.warmup; index += 1) {
    options.beforeEach?.();
    for (let call = 0; call < batchSize; call += 1) fn();
  }
  const samples: number[] = [];
  for (let index = 0; index < options.iters; index += 1) {
    options.beforeEach?.();
    const started = performance.now();
    for (let call = 0; call < batchSize; call += 1) fn();
    samples.push((performance.now() - started) * 1e6);
  }
  return summarize(samples, options, batchSize, batchSize === 1 ? "sync-single" : "sync-batch");
}

function summarize(
  samples: readonly number[],
  options: Pick<MeasureOptions, "warmup" | "iters">,
  batchSize: number,
  timingMode: Measurement["timingMode"],
): Measurement {
  const sorted = samples.map((sample) => sample / batchSize).sort((left, right) => left - right);
  return {
    iters: options.iters,
    warmup: options.warmup,
    batchSize,
    timingMode,
    sampleUnit: "ns",
    samplesNs: samples,
    statistic: batchSize === 1 ? "single-call" : "batch-mean",
    nsMedian: sorted[Math.floor(sorted.length / 2)]!,
    nsP95: percentile(sorted, 95),
  };
}

export function recordCase(entry: BenchCase): void {
  const path =
    process.env.PERF_TS_OUT ??
    resolve(process.cwd(), ".private/perf/ts-cases.json");
  mkdirSync(dirname(path), { recursive: true });
  const cases: BenchCase[] = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as BenchCase[])
    : [];
  writeFileSync(
    path,
    `${JSON.stringify([...cases.filter((existing) => existing.id !== entry.id), entry], null, 2)}\n`,
  );
}
