// Load the candidate a release.yml run built: `--run <id>` downloads its
// `candidate` artifact with gh; `--candidate <dir>` uses a local directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCandidate } from "./candidate.ts";

export function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function scratch(label) {
  return mkdtempSync(path.join(tmpdir(), `boundary-${label}-`));
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}

export async function ciCandidate(args) {
  const local = option(args, "--candidate");
  const runId = option(args, "--run");
  if (Boolean(local) === Boolean(runId)) throw new Error("pass exactly one of --run <release.yml run id> or --candidate <dir>");
  if (local) {
    const root = path.resolve(local);
    return { root, candidate: await verifyCandidate(root) };
  }
  const root = scratch("ci-candidate");
  run("gh", ["run", "download", runId, "--name", "candidate", "--dir", root], { stdio: "inherit" });
  return { root, candidate: await verifyCandidate(root) };
}
