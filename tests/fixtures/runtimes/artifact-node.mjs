import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparePackageArtifacts,
  verifyContentManifest,
  verifyPackReceipt,
  writeContentManifest,
} from "@foxworth/boundary/artifact";

const receiptPath = process.argv[2];
assert.equal(typeof receiptPath, "string", "explicit packed receipt required");
const root = path.dirname(fileURLToPath(import.meta.resolve("@foxworth/boundary/package.json")));
const packed = await verifyPackReceipt(receiptPath, { name: "@foxworth/boundary" });
const content = await verifyContentManifest(root, {
  name: packed.receipt.package.name,
  version: packed.receipt.package.version,
  aggregateDigest: packed.receipt.contentDigest,
});
const source = { root, receiptPath, expected: { aggregateDigest: content.aggregateDigest } };
const matching = await comparePackageArtifacts({ before: source, after: source, requiredExports: ["./artifact", "./program"] });
assert.equal(matching.identity.sameContent, true);
assert.equal(matching.identity.sameTarball, true);
assert.deepEqual(matching.exports.missingAfter, []);
assert.equal(matching.before.metadata.engines.node, ">=24.21");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "boundary-artifact-packed-proof-"));
try {
  const candidateRoot = path.join(temporaryRoot, "candidate");
  await cp(root, candidateRoot, { recursive: true });
  const manifestPath = path.join(candidateRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports["./handoff"] = null;
  manifest.engines.node = ">=26.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await writeFile(path.join(candidateRoot, "probe.txt"), "a distinct candidate with the same version\n");
  const candidate = await writeContentManifest(candidateRoot, content.package);
  const contract = {
    version: 1,
    id: "packed.artifact.change",
    inputSchema: { type: "string" },
    outputSchema: { type: "boolean" },
    reads: ["documents"],
    changes: ["documents"],
  };
  const report = await comparePackageArtifacts({
    before: source,
    after: { root: candidateRoot, expected: { aggregateDigest: candidate.aggregateDigest } },
    requiredExports: ["./artifact", "./handoff"],
    contracts: [{ before: contract, after: { ...contract, changes: ["accounts", "documents"] } }],
  });
  assert.equal(report.identity.sameName, true);
  assert.equal(report.identity.sameVersion, true);
  assert.equal(report.identity.versionReusedWithDifferentContent, true);
  assert.equal(report.identity.sameTarball, null);
  assert.deepEqual(report.exports.missingAfter, ["./handoff"]);
  assert.deepEqual(report.runtimes.changed, ["node"]);
  assert.equal(report.contracts.deltas[0].delta.existingCallers.compatible, false);
  assert.equal(report.contracts.source, "caller-supplied");
  await assert.rejects(() => comparePackageArtifacts({ before: source, after: { root: candidateRoot, receiptPath } }), /receipt does not identify/);
  await writeFile(path.join(candidateRoot, "probe.txt"), "tampered candidate bytes\n");
  await assert.rejects(() => comparePackageArtifacts({ before: source, after: { root: candidateRoot } }), /package file does not match/);
  const tarballPath = path.join(temporaryRoot, packed.receipt.tarball.filename);
  const copiedReceipt = `${tarballPath}.receipt.json`;
  await cp(packed.tarballPath, tarballPath);
  await cp(receiptPath, copiedReceipt);
  const bytes = await readFile(tarballPath);
  bytes[0] ^= 1;
  await writeFile(tarballPath, bytes);
  await assert.rejects(() => verifyPackReceipt(copiedReceipt), /tarball SHA-256/);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
console.log("Packed artifact tooling verifies receipts, explicit exports, runtime requirements, supplied contract deltas, and rejects tampering.");
