// Opt-in end-to-end timings. Existing compiler caches are deliberately retained.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { gitMeta, machineMeta, perfDir, root } from "./lib.mjs";

const label = process.argv[2] ?? "run";
const rounds = Number(process.argv[3] ?? 2);
if (!/^[a-zA-Z0-9_-]+$/.test(label) || !Number.isSafeInteger(rounds) || rounds < 1)
  throw new Error("usage: node scripts/perf/guests.mjs LABEL POSITIVE_ROUND_COUNT");
const directory = join(perfDir, "guests", `${label}-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(directory, { recursive: true });
const report = {
  label, git: gitMeta(), machine: { ...machineMeta(), cpuCount: cpus().length },
  method: "Sequential complete matrix runs. Existing native/compiler caches retained. Row wall time includes build, validation, cargo, and tests. Test seconds come from the Rust test harness. Cached component builds still validate and execute all assertions.",
  rows: [],
};
const output = join(directory, "results.json");
const artifacts = {
  zig: "zig/zig-out/thumbnail.component.wasm",
  rust: "rust/target/wasm32-unknown-unknown/release/boundary_thumbnail_guest.wasm",
  js: "javascript/thumbnail.component.wasm",
  python: "python/thumbnail.component.wasm",
  go: "go/thumbnail.component.wasm",
};
const script = "scripts/wasm/guests.sh";
function status(action) {
  const result = spawnSync("bash", [script, action], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`matrix ${action} failed (${result.status})`);
}
for (let run = 1; run <= rounds; run++) {
  status("reset");
  for (const [row, artifact] of Object.entries(artifacts)) {
    const log = join(directory, `${run}-${row}.log`);
    console.log(`starting ${label} round ${run}: ${row} (${log})`);
    const descriptor = openSync(log, "w");
    const started = performance.now();
    let result;
    try { result = spawnSync("bash", [script, row], { cwd: root, stdio: ["ignore", descriptor, descriptor] }); }
    finally { closeSync(descriptor); }
    const wallSeconds = (performance.now() - started) / 1000;
    const text = readFileSync(log, "utf8");
    const tests = [...text.matchAll(/test result: ok\. (\d+) passed; .*?finished in ([\d.]+)s/g)];
    const entry = { run, row, wallSeconds, exit: result.status,
      testSeconds: tests.reduce((sum, match) => sum + Number(match[2]), 0),
      passed: tests.reduce((sum, match) => sum + Number(match[1]), 0),
      buildCached: text.includes("cached:"), log };
    if (entry.exit === 0 && entry.passed > 0) {
      const bytes = readFileSync(join(root, "examples/guests/thumbnail", artifact));
      entry.artifactBytes = bytes.byteLength;
      entry.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    }
    report.rows.push(entry);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${row}: ${wallSeconds.toFixed(3)}s wall, ${entry.testSeconds.toFixed(3)}s tests, ${entry.passed} passed`);
    if (result.error) throw result.error;
    if (entry.exit !== 0 || entry.passed === 0) throw new Error(`matrix row failed or blocked: ${log}`);
  }
  status("summary");
}
console.log(`wrote ${output}`);
