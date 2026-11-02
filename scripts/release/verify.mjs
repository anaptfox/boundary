// After `npm stage approve`: prove npm serves the CI candidate's bytes with valid
// signatures and provenance. Usage: verify.mjs (--run <id> | --candidate <dir>)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ciCandidate, run, scratch } from "./ci-candidate.mjs";

const { candidate } = await ciCandidate(process.argv.slice(2));
const spec = `${candidate.name}@${candidate.version}`;
let served = "";
try {
  served = run("npm", ["view", spec, "dist.integrity"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  throw new Error(`npm does not serve ${spec}; approve the staged version first`);
}
if (served !== candidate.integrity) throw new Error(`npm serves ${served || "nothing"} for ${spec}; the CI candidate is ${candidate.integrity}`);

const consumer = scratch("published-consumer");
writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "boundary-published-consumer", private: true, type: "module" })}\n`);
run("npm", ["install", "--ignore-scripts", "--no-fund", spec, "zod"], { cwd: consumer, stdio: "inherit" });
run("npm", ["audit", "signatures"], { cwd: consumer, stdio: "inherit" });
run(process.execPath, ["--input-type=module", "-e", `const m = await import("@foxworth/boundary"); if (typeof m.defineInteraction !== "function") process.exit(1);`], { cwd: consumer });

process.stdout.write(`${JSON.stringify({ published: spec, integrity: served, signatures: "verified", rootImport: "passed" }, null, 2)}\n`);
process.stdout.write(`\nTag the release: git tag -a v${candidate.version} <release commit> && git push origin v${candidate.version}\n`);
