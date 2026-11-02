// Before `npm stage approve`: prove the staged tarball is the CI candidate and
// show what it contains. Usage: review.mjs <stage-id> (--run <id> | --candidate <dir>)
import { readdirSync } from "node:fs";
import path from "node:path";
import { compareStaged } from "./candidate.ts";
import { ciCandidate, run, scratch } from "./ci-candidate.mjs";

const args = process.argv.slice(2);
const stageId = args[0];
if (!stageId || stageId.startsWith("--")) throw new Error("usage: review.mjs <stage-id> (--run <id> | --candidate <dir>)");
const { candidate } = await ciCandidate(args);

process.stdout.write(run("npm", ["stage", "view", stageId]));
const stagedRoot = scratch("staged");
run("npm", ["stage", "download", stageId], { cwd: stagedRoot, stdio: "inherit" });
const staged = readdirSync(stagedRoot).filter((name) => name.endsWith(".tgz"));
if (staged.length !== 1) throw new Error(`npm stage download produced ${staged.length} tarballs`);
const stagedTarball = path.join(stagedRoot, staged[0]);
await compareStaged(candidate, stagedTarball);

const manifest = JSON.parse(run("tar", ["-xzOf", stagedTarball, "package/package.json"]));
const files = run("tar", ["-tzf", stagedTarball]).trim().split("\n");
process.stdout.write(`${JSON.stringify({
  matchesCiCandidate: true,
  name: manifest.name,
  version: manifest.version,
  integrity: candidate.integrity,
  exports: Object.keys(manifest.exports ?? {}),
  peerDependencies: manifest.peerDependencies ?? {},
  files: files.length,
  topLevel: [...new Set(files.map((file) => file.split("/").slice(0, 2).join("/")))],
}, null, 2)}\n`);
process.stdout.write(`\nIf this is what you intend to release: npm stage approve ${stageId}\n`);
