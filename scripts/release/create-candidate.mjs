// Build the release candidate: `--output DIR` (default release-candidate/).
import path from "node:path";
import { createCandidate, workspaceRoot } from "./candidate.ts";

const index = process.argv.indexOf("--output");
const outputRoot = path.resolve(workspaceRoot, index === -1 ? "release-candidate" : process.argv[index + 1] ?? "");
const candidate = await createCandidate({ outputRoot });
process.stdout.write(`${JSON.stringify({ output: outputRoot, candidate }, null, 2)}\n`);
