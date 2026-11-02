import { execFileSync } from "node:child_process";
import path from "node:path";
import { ARTIFACT_ROOT, WORKSPACE_ROOT } from "./sdk.ts";

const checkOnly = process.argv.slice(2).includes("--check");
const report = JSON.parse(execFileSync(
  process.execPath,
  [
    path.join(WORKSPACE_ROOT, "scripts/build/pack-artifact.mjs"),
    "--root",
    ARTIFACT_ROOT,
    ...(checkOnly ? ["--check"] : ["--output", ARTIFACT_ROOT]),
  ],
  { cwd: WORKSPACE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
));

process.stdout.write(`${JSON.stringify({ version: 1, artifacts: [report] }, null, 2)}\n`);
