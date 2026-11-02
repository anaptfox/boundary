import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateReports, assembleReport, assertComparable, assertSourceUnchanged,
  compareReports, fingerprintFiles, writeReport } from "../../scripts/perf/lib.mjs";

function report(options = {}) {
  const cases = [{ id: "ts.example", lang: "ts", class: "per-call", iters: 3,
    warmup: 2, batchSize: 10, timingMode: "sync-batch", sampleUnit: "ns", statistic: "batch-mean",
    samplesNs: [300, 100, 200], nsMedian: 20, nsP95: 30 }];
  return assembleReport(cases, { mode: "ts-only",
    machine: { node: "v24.21.0", rustc: "rustc-test", cpus: 4, cpuModels: ["test"], platform: "test", osRelease: "test" },
    provenance: { git: { sha: "before", dirty: false }, production: { sha256: "production-before" }, harness: { sha256: "harness" } },
    runtime: { flags: [], environmentFlags: {}, commands: [{ command: "test", args: [] }] }, ...options });
}

test("comparison allows production changes and computes absolute summary deltas", () => {
  const before = report(), after = report();
  after.git.sha = "after";
  after.provenance.production.sha256 = "production-after";
  after.cases[0].nsMedian = 10;
  assertComparable(before, after);
  assert.equal(compareReports(before, after)[0].medianDelta, -0.5);
});

test("old reports are explicitly incomparable", () => {
  assert.throws(() => compareReports({ cases: [] }, report()), /legacy reports are incomparable/);
});

for (const [name, mutate] of [
  ["CPU", (r) => { r.machine.cpuModels = ["different"]; }],
  ["runtime", (r) => { r.machine.node = "v24.22.0"; }],
  ["OS", (r) => { r.machine.osRelease = "different"; }],
  ["mode", (r) => { r.mode = "ts-and-rust"; }],
  ["harness", (r) => { r.provenance.harness.sha256 = "changed"; }],
  ["flags", (r) => { r.runtime.flags = ["--jitless"]; }],
  ["environment flags", (r) => { r.runtime.environmentFlags.NODE_OPTIONS = "--jitless"; }],
  ["command", (r) => { r.runtime.commands[0].args = ["other"]; }],
  ["batch size", (r) => { r.cases[0].batchSize = 20; }],
  ["timing mode", (r) => { r.cases[0].timingMode = "async-single"; }],
  ["iterations", (r) => { r.cases[0].iters = 5; }],
  ["case set", (r) => { r.cases.push({ ...r.cases[0], id: "extra" }); }],
  ["missing metadata", (r) => { delete r.runtime; }],
  ["invalid timing", (r) => { r.cases[0].nsMedian = Number.NaN; }],
]) test(`comparison rejects different ${name}`, () => {
  const before = report(), after = report();
  mutate(after);
  assert.throws(() => compareReports(before, after), /incomparable reports/);
});

test("aggregation retains process variation without pooling samples or mutating inputs", () => {
  const runs = [report(), report(), report()];
  runs[1].cases[0].nsMedian = 50;
  runs[2].cases[0].nsMedian = 10;
  const result = aggregateReports(runs).cases[0];
  assert.equal(result.nsMedian, 20);
  assert.deepEqual(result.processMediansNs, [20, 50, 10]);
  assert.equal(result.processMedianMinNs, 10);
  assert.equal(result.processMedianMaxNs, 50);
  assert.equal(result.processMedianSpreadNs, 40);
  assert.equal(result.processRuns, 3);
  assert.equal(result.samplesNs, undefined);
  assert.deepEqual(runs[0].cases[0].samplesNs, [300, 100, 200]);
  assert.equal(aggregateReports(runs.slice(0, 2)).cases[0].nsMedian, 35);
});

test("aggregation rejects mixed production and an empty run", () => {
  const changed = report();
  changed.provenance.production.sha256 = "different";
  assert.throws(() => aggregateReports([report(), changed]), /production source changed/);
  assert.throws(() => aggregateReports([]), /no process reports/);
});

test("source fingerprints include exact contents and path, and detect edits", () => {
  const directory = mkdtempSync(join(tmpdir(), "boundary-perf-test-"));
  try {
    writeFileSync(join(directory, "a"), "first");
    writeFileSync(join(directory, "b"), "first");
    const before = fingerprintFiles(["a"], directory);
    assert.notEqual(before.sha256, fingerprintFiles(["b"], directory).sha256);
    assert.deepEqual(fingerprintFiles(["b", "a"], directory), fingerprintFiles(["a", "b"], directory));
    writeFileSync(join(directory, "a"), "second");
    const after = fingerprintFiles(["a"], directory);
    assert.notEqual(before.sha256, after.sha256);
    assert.throws(() => assertSourceUnchanged({ production: before, harness: before }, { production: after, harness: before }), /production source changed/);
  } finally { rmSync(directory, { recursive: true }); }
});

test("immutable report writes never overwrite an existing artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "boundary-perf-test-"));
  try {
    const path = join(directory, "report.json");
    writeReport(path, report(), true);
    assert.throws(() => writeReport(path, report(), true), /EEXIST/);
  } finally { rmSync(directory, { recursive: true }); }
});
