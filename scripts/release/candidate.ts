// A release candidate is the exact tarball CI stages on npm: one packed SDK plus
// its pack receipt, built from a clean checkout, reproducible byte for byte.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackReceipt } from "../../packages/core/artifact/integrity.ts";
import { ARTIFACT_ROOT, SDK_NAME } from "../build/sdk.ts";

export const SIZE_BUDGET_BYTES = 2_000_000;

export type Candidate = Readonly<{
  name: string;
  version: string;
  tarball: string;
  bytes: number;
  sha256: string;
  /** npm's `dist.integrity` form: `sha512-<base64>`. */
  integrity: string;
  contentDigest: string;
}>;

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).trim();
}

/** npm's integrity string for exact tarball bytes. */
export function npmIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// The output is deleted before packing, so it must be release-candidate/ or
// sit inside a temporary root: the OS one, or GitHub Actions' $RUNNER_TEMP.
function safeOutputRoot(value: string): string {
  const resolved = path.resolve(value);
  const inWorkspace = path.join(workspaceRoot, "release-candidate");
  if (resolved === inWorkspace || resolved.startsWith(`${inWorkspace}${path.sep}`)) return resolved;
  const temporaryRoots = [tmpdir(), process.env.RUNNER_TEMP].filter((root): root is string => Boolean(root));
  for (const root of temporaryRoots.map((root) => path.resolve(root))) {
    if (resolved !== root && resolved.startsWith(`${root}${path.sep}`)) return resolved;
  }
  throw new Error("Candidate output must be release-candidate/ or a child of a temporary directory");
}

/** Build and pack the SDK from a clean checkout into `outputRoot`. */
export async function createCandidate({ outputRoot, build = true }: { outputRoot: string; build?: boolean }): Promise<Candidate> {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Release candidates require a clean working tree");
  }
  const output = safeOutputRoot(outputRoot);
  if (build) execFileSync(process.execPath, [path.join(workspaceRoot, "scripts/build/build-packages.mjs")], { cwd: workspaceRoot, stdio: "inherit" });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  execFileSync(
    process.execPath,
    [path.join(workspaceRoot, "scripts/build/pack-artifact.mjs"), "--root", ARTIFACT_ROOT, "--output", output],
    { cwd: workspaceRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
  return verifyCandidate(output);
}

/** Verify a candidate directory holds exactly one SDK tarball and its matching receipt. */
export async function verifyCandidate(root: string): Promise<Candidate> {
  const files = (await readdir(root)).sort();
  const receipts = files.filter((name) => name.endsWith(".receipt.json"));
  if (receipts.length !== 1 || files.length !== 2) {
    throw new Error(`Candidate must contain one tarball and its receipt; found ${files.join(", ") || "nothing"}`);
  }
  const verified = await verifyPackReceipt(path.join(root, receipts[0]!), { name: SDK_NAME });
  const { tarball } = verified.receipt;
  if (!files.includes(tarball.filename)) throw new Error(`Candidate receipt names a missing tarball ${tarball.filename}`);
  if (tarball.bytes > SIZE_BUDGET_BYTES) throw new Error(`${SDK_NAME} exceeds the ${SIZE_BUDGET_BYTES} byte release budget`);
  return {
    name: verified.receipt.package.name,
    version: verified.receipt.package.version,
    tarball: tarball.filename,
    bytes: tarball.bytes,
    sha256: tarball.sha256,
    integrity: npmIntegrity(await readFile(verified.tarballPath)),
    contentDigest: verified.receipt.contentDigest,
  };
}

/** Two candidates are reproducible when every file is byte-identical. */
export async function compareCandidates(left: string, right: string): Promise<Candidate> {
  const [a, b] = await Promise.all([verifyCandidate(left), verifyCandidate(right)]);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Candidate bytes are not reproducible");
  return a;
}

/** The tarball npm staged must be byte-identical to the CI candidate. */
export async function compareStaged(candidate: Candidate, stagedTarball: string): Promise<void> {
  const staged = npmIntegrity(await readFile(stagedTarball));
  if (staged !== candidate.integrity) {
    throw new Error(`Staged tarball ${staged} does not match the CI candidate ${candidate.integrity}`);
  }
}
