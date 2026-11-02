import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyContentManifest,
  verifyPackReceipt,
  writePackReceipt,
} from "../../packages/core/artifact/integrity.ts";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.includes("--check");
const rootIndex = argumentsList.indexOf("--root");
const outputIndex = argumentsList.indexOf("--output");
if (rootIndex !== -1 && argumentsList[rootIndex + 1] === undefined) {
  throw new Error("--root requires a directory");
}
if (checkOnly && outputIndex !== -1) {
  throw new Error("--check and --output cannot be combined");
}
if (outputIndex !== -1 && argumentsList[outputIndex + 1] === undefined) {
  throw new Error("--output requires a directory");
}
const publishRoot = rootIndex === -1
  ? path.join(packageRoot, "..", "dist", "boundary")
  : path.resolve(process.cwd(), argumentsList[rootIndex + 1]);
const temporaryOutput = checkOnly
  ? await mkdtemp(path.join(tmpdir(), "boundary-pack-check-"))
  : undefined;
const outputRoot = temporaryOutput ?? (
  outputIndex === -1
    ? publishRoot
    : path.resolve(process.cwd(), argumentsList[outputIndex + 1])
);
const npmCache = await mkdtemp(path.join(tmpdir(), "boundary-pack-cache-"));

try {
  const content = await verifyContentManifest(publishRoot);
  const stdout = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputRoot,
      "--cache",
      npmCache,
    ],
    { cwd: publishRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  let packed;
  try {
    const report = JSON.parse(stdout);
    if (!Array.isArray(report) || report.length !== 1) {
      throw new Error("npm pack did not report exactly one artifact");
    }
    [packed] = report;
  } catch (error) {
    throw new Error("npm pack --json returned an invalid report", { cause: error });
  }
  if (
    packed.name !== content.package.name ||
    packed.version !== content.package.version ||
    typeof packed.filename !== "string" ||
    path.basename(packed.filename) !== packed.filename
  ) {
    throw new Error("npm pack identity does not match the content manifest");
  }

  const tarballPath = path.join(outputRoot, packed.filename);
  const { receiptPath } = await writePackReceipt({
    tarballPath,
    packageName: content.package.name,
    packageVersion: content.package.version,
    contentDigest: content.aggregateDigest,
  });
  const verified = await verifyPackReceipt(receiptPath, {
    name: content.package.name,
    version: content.package.version,
  });

  process.stdout.write(`${JSON.stringify({
    version: 1,
    package: verified.receipt.package,
    tarball: verified.tarballPath,
    receipt: receiptPath,
    bytes: verified.receipt.tarball.bytes,
    sha256: verified.receipt.tarball.sha256,
    contentDigest: verified.receipt.contentDigest,
    note: "SHA-256 verifies integrity against this receipt; it is not signing or publisher authentication.",
  }, null, 2)}\n`);
} finally {
  await rm(npmCache, { recursive: true, force: true });
  if (temporaryOutput !== undefined) {
    await rm(temporaryOutput, { recursive: true, force: true });
  }
}
