import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, release, version } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const perfDir = resolve(root, ".private/perf");
export const schemaVersion = 2;
const aggregation = "median-of-process-medians-v1";

export function gitMeta() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  return { sha, dirty };
}
function commandVersion(command, args) {
  try { return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unavailable"; }
}
export function machineMeta() {
  const processors = cpus();
  // Sandboxed macOS can hide os.cpus(). Explicit values must come from a
  // separately observed machine; unavailable metadata must not imply zero CPUs.
  const suppliedCount = Number(process.env.PERF_CPU_COUNT);
  const count = processors.length || (Number.isSafeInteger(suppliedCount) && suppliedCount > 0 ? suppliedCount : null);
  const models = processors.length ? [...new Set(processors.map((cpu) => cpu.model))].sort()
    : process.env.PERF_CPU_MODEL ? [process.env.PERF_CPU_MODEL] : [];
  return { cpus: count, cpuModels: models,
    cpuMetadataSource: processors.length ? "os.cpus" : count && models.length ? "explicit-observation" : "unavailable",
    node: process.version, v8: process.versions.v8, pnpm: commandVersion("pnpm", ["--version"]),
    rustc: commandVersion("rustc", ["--version"]), platform: `${process.platform}-${process.arch}`,
    osRelease: release(), osVersion: version() };
}
function filesUnder(directory, accept) {
  if (!existsSync(resolve(root, directory))) return [];
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", "target", "dist", "publish", ".git"].includes(entry.name)) continue;
      const absolute = resolve(path, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && accept(relative(root, absolute))) files.push(relative(root, absolute));
    }
  }
  walk(resolve(root, directory));
  return files;
}
export function fingerprintFiles(paths, directory = root) {
  const hash = createHash("sha256");
  const files = [...new Set(paths)].sort().map((path) => {
    const content = readFileSync(resolve(directory, path));
    // Include names and lengths so file boundaries cannot produce ambiguous input.
    hash.update(`${path}\0${content.length}\0`).update(content);
    return { path, sha256: createHash("sha256").update(content).digest("hex") };
  });
  return { sha256: hash.digest("hex"), files };
}
export function sourceProvenance(mode = "ts-and-rust") {
  const ts = filesUnder("packages", (path) => /\.tsx?$/.test(path) && !/\.(test|spec)\./.test(path));
  const rust = mode === "ts-only" ? [] : filesUnder("crates", (path) => /\/src\/|\/(Cargo\.toml|build\.rs)$/.test(path));
  const harness = [
    ...filesUnder("scripts/perf", (path) => path.endsWith(".mjs") && !path.endsWith(".test.mjs")),
    ...filesUnder("tests/typescript/perf", () => true),
    ...filesUnder("tests/typescript/helpers", () => true),
    ...filesUnder("tests/fixtures", () => true), ...filesUnder("config", (file) => file.endsWith(".json")),
    ...(mode === "ts-only" ? [] : filesUnder("crates", (path) => /\/benches\//.test(path))),
    "package.json", "packages/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "tsconfig.json", "config/vitest.perf.config.ts", ".node-version",
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
  ].filter((path) => existsSync(resolve(root, path)));
  return { git: gitMeta(), production: fingerprintFiles([...ts, ...rust]), harness: fingerprintFiles(harness) };
}
export function assertSourceUnchanged(before, after) {
  for (const key of ["production", "harness"]) {
    if (before[key].sha256 !== after[key].sha256) throw new Error(`${key} source changed during benchmark; report rejected`);
  }
}
export function runtimeMeta(commands = []) {
  return { executable: process.execPath, flags: process.execArgv, environmentFlags: {
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "", RUSTFLAGS: process.env.RUSTFLAGS ?? "",
    CARGO_ENCODED_RUSTFLAGS: process.env.CARGO_ENCODED_RUSTFLAGS ?? "",
  }, commands };
}
export function ensurePerfDir() { mkdirSync(perfDir, { recursive: true }); }
export function reportPath(kind, when = new Date()) {
  const stamp = when.toISOString().replaceAll(":", "").replaceAll(".", "-");
  return resolve(perfDir, `${kind}-${gitMeta().sha.slice(0, 12)}-${stamp}.json`);
}
export function writeReport(path, report, immutable = false) {
  ensurePerfDir();
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: immutable ? "wx" : "w" });
}
export function readReport(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function resolveReportArg(value, fallbackName) { return resolve(root, value || `.private/perf/${fallbackName}`); }
function caseWorkload(entry) {
  return { id: entry.id, lang: entry.lang, class: entry.class, iters: entry.iters,
    warmup: entry.warmup ?? null, batchSize: entry.batchSize ?? null,
    timingMode: entry.timingMode ?? null, sampleUnit: entry.sampleUnit ?? null,
    statistic: entry.statistic ?? null, workload: entry.workload ?? null };
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function assembleReport(cases, options = {}) {
  const provenance = options.provenance ?? sourceProvenance(options.mode);
  const workloads = cases.map(caseWorkload).sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion, git: provenance.git, when: new Date().toISOString(),
    machine: options.machine ?? machineMeta(), provenance, mode: options.mode ?? "ts-and-rust",
    runtime: options.runtime ?? runtimeMeta(), workload: { sha256: digest(workloads), cases: workloads },
    aggregation, cases };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function aggregateReports(reports) {
  if (reports.length === 0) throw new Error("no process reports to aggregate");
  assertComparable(reports[0], reports[0]);
  for (const report of reports.slice(1)) {
    assertComparable(reports[0], report);
    assertSourceUnchanged(reports[0].provenance, report.provenance);
  }
  const cases = reports[0].cases.map((entry) => {
    const rounds = reports.map((report) => report.cases.find((candidate) => candidate.id === entry.id));
    const medians = rounds.map((round) => round.nsMedian), p95s = rounds.map((round) => round.nsP95);
    const { samplesNs: _samples, ...metadata } = entry;
    return { ...metadata, nsMedian: median(medians), nsP95: median(p95s), processRuns: rounds.length,
      processMediansNs: medians, processMedianMinNs: Math.min(...medians),
      processMedianMaxNs: Math.max(...medians), processMedianSpreadNs: Math.max(...medians) - Math.min(...medians),
      processP95sNs: p95s };
  });
  return { ...reports[0], when: new Date().toISOString(), rounds: reports.length, cases,
    method: "Fresh sequential benchmark processes; aggregate median of per-process medians and median of per-process p95 values. Process-median min/max/spread describe observed run variation, not confidence intervals. Raw chronological samples are retained in individual process reports." };
}
export function persistRun(report, options = {}) {
  ensurePerfDir();
  const stamped = options.label ? resolve(perfDir, `${options.label}.json`) : reportPath("run", new Date(report.when));
  writeReport(stamped, report, true);
  const current = resolve(perfDir, "current.json");
  writeReport(current, report);
  const baseline = resolve(perfDir, "baseline.json");
  if (!existsSync(baseline)) writeReport(baseline, report, true);
  return { stamped, baseline, current };
}
export function comparabilityIssues(before, after) {
  if (before.schemaVersion !== schemaVersion || after.schemaVersion !== schemaVersion) {
    return [`schemaVersion must be ${schemaVersion}; legacy reports are incomparable`];
  }
  const fields = [
    ["machine", before.machine, after.machine], ["mode", before.mode, after.mode],
    ["harness fingerprint", before.provenance?.harness?.sha256, after.provenance?.harness?.sha256],
    ["workload fingerprint", before.workload?.sha256, after.workload?.sha256],
    ["aggregation", before.aggregation, after.aggregation],
    ["runtime flags", before.runtime?.flags, after.runtime?.flags],
    ["runtime environment flags", before.runtime?.environmentFlags, after.runtime?.environmentFlags],
    ["commands", before.runtime?.commands, after.runtime?.commands],
  ];
  const issues = [];
  for (const [name, left, right] of fields) {
    if (left === undefined || right === undefined) issues.push(`missing ${name}`);
    else if (JSON.stringify(left) !== JSON.stringify(right)) issues.push(`${name} differs`);
  }
  // Recompute from stored metadata; do not trust a stale workload digest.
  for (const [name, report] of [["before", before], ["after", after]]) {
    if (!Array.isArray(report.cases) || report.cases.length === 0) { issues.push(`${name} has no cases`); continue; }
    const workloads = report.cases.map(caseWorkload).sort((a, b) => a.id.localeCompare(b.id));
    if (digest(workloads) !== report.workload?.sha256) issues.push(`${name} workload metadata does not match fingerprint`);
    const ids = new Set();
    for (const entry of report.cases) {
      if (ids.has(entry.id)) issues.push(`${name} has duplicate case ${entry.id}`);
      ids.add(entry.id);
      if (![entry.nsMedian, entry.nsP95].every((value) => Number.isFinite(value) && value >= 0)) issues.push(`${name} has invalid timings for ${entry.id}`);
    }
  }
  return issues;
}
export function assertComparable(before, after) {
  const issues = comparabilityIssues(before, after);
  if (issues.length) throw new Error(`incomparable reports: ${issues.join("; ")}`);
}
function delta(before, after) { return before === 0 ? (after === 0 ? 0 : Number.POSITIVE_INFINITY) : (after - before) / before; }
export function compareReports(before, after) {
  assertComparable(before, after);
  const beforeById = new Map(before.cases.map((entry) => [entry.id, entry]));
  return [...after.cases].sort((a, b) => a.id.localeCompare(b.id)).map((right) => {
    const left = beforeById.get(right.id);
    return { id: right.id, lang: right.lang, class: right.class, medianDelta: delta(left.nsMedian, right.nsMedian),
      p95Delta: delta(left.nsP95, right.nsP95), before: left, after: right };
  });
}
