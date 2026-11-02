import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateReports, assembleReport, assertSourceUnchanged, ensurePerfDir, machineMeta,
  persistRun, perfDir, reportPath, root, runtimeMeta, sourceProvenance, writeReport } from "./lib.mjs";

const options = { rounds: 1, label: undefined, mode: "ts-and-rust" };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--rounds") options.rounds = Number(process.argv[++index]);
  else if (arg === "--label") {
    options.label = process.argv[++index];
    if (options.label === undefined) throw new Error("--label requires a name");
  }
  else if (arg === "--ts-only") options.mode = "ts-only";
  else throw new Error(`unknown argument: ${arg}`);
}
if (!Number.isSafeInteger(options.rounds) || options.rounds < 1 ||
    (options.label !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.label))) {
  throw new Error("usage: node scripts/perf/run.mjs [--rounds N] [--label NAME] [--ts-only]");
}
ensurePerfDir();
if (options.label && existsSync(resolve(perfDir, `${options.label}.json`))) throw new Error(`immutable report already exists: ${options.label}.json`);
const commands = [{ command: "pnpm", args: ["exec", "vitest", "run", "--config", "config/vitest.perf.config.ts"] }];
if (options.mode !== "ts-only") commands.push({ command: "cargo", args: ["bench", "-p", "boundary-core", "--bench", "baseline", "--features", "derive"] });
const machine = machineMeta(), provenance = sourceProvenance(options.mode), runtime = runtimeMeta(commands);
const reports = [], processReports = [], prefix = options.label ?? `run-${Date.now()}`;
for (let round = 1; round <= options.rounds; round++) {
  const cases = [];
  console.log(`benchmark ${prefix} round ${round}/${options.rounds} (${options.mode})`);
  assertSourceUnchanged(provenance, sourceProvenance(options.mode));
  for (const invocation of commands) {
    const language = invocation.command === "cargo" ? "rust" : "ts";
    const output = resolve(perfDir, `${prefix}-round-${round}-${language}-cases.json`);
    writeFileSync(output, "[]\n", { flag: "wx" });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root, env: { ...process.env, [language === "rust" ? "PERF_RUST_OUT" : "PERF_TS_OUT"]: output }, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${language} benchmark failed (${result.status ?? result.signal}); aggregate report not written`);
    const measured = JSON.parse(readFileSync(output, "utf8"));
    if (!Array.isArray(measured) || measured.length === 0) throw new Error(`${language} benchmark produced no cases`);
    cases.push(...measured);
    assertSourceUnchanged(provenance, sourceProvenance(options.mode));
  }
  const report = assembleReport(cases, { mode: options.mode, machine, provenance, runtime });
  report.round = round;
  const path = reportPath(`${prefix}-round-${round}`);
  writeReport(path, report, true);
  reports.push(report); processReports.push(path);
  console.log(`retained process report ${path}`);
}
assertSourceUnchanged(provenance, sourceProvenance(options.mode));
const aggregate = { ...aggregateReports(reports), invocation: process.argv, processReports };
const paths = persistRun(aggregate, options);
console.log(`wrote ${paths.stamped}`);
console.log(`current ${paths.current}`);
console.log(`baseline ${paths.baseline} (preserved when already present)`);
