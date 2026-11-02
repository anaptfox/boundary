import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  comparePackageArtifacts,
  verifyContentManifest,
  writeContentManifest,
  writePackReceipt,
  type ArtifactDigest,
} from "@foxworth/boundary/artifact";
import type { InteractionContract } from "@foxworth/boundary/program";
import * as packageScript from "../../packages/core/artifact/integrity.ts";

const temporary: string[] = [];
const identity = { name: "@example/service", version: "1.0.0" };
const missingDigest: ArtifactDigest = `sha256:${"a".repeat(64)}`;

async function fixture(options: {
  code?: string;
  exports?: unknown;
  engines?: unknown;
  name?: string;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "boundary-artifact-comparison-"));
  temporary.push(root);
  const packageIdentity = { ...identity, ...(options.name === undefined ? {} : { name: options.name }) };
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    ...packageIdentity,
    type: "module",
    exports: options.exports ?? { ".": "./index.js", "./program": "./program.js" },
    engines: options.engines ?? { node: ">=24.21" },
  }));
  await writeFile(path.join(root, "index.js"), options.code ?? "export const result = 1;\n");
  await writeFile(path.join(root, "program.js"), "export const program = true;\n");
  const content = await writeContentManifest(root, packageIdentity);
  return { root, content };
}

async function receiptFor(value: Awaited<ReturnType<typeof fixture>>, bytes = "packed bytes") {
  const tarballPath = path.join(value.root, "example-service-1.0.0.tgz");
  await writeFile(tarballPath, bytes);
  return writePackReceipt({
    tarballPath,
    packageName: identity.name,
    packageVersion: identity.version,
    contentDigest: value.content.aggregateDigest,
  });
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("supported Node artifact inspection", () => {
  it("keeps package scripts on the exact public integrity algorithms", () => {
    expect(packageScript.verifyContentManifest).toBe(verifyContentManifest);
    expect(packageScript.writeContentManifest).toBe(writeContentManifest);
    expect(packageScript.writePackReceipt).toBe(writePackReceipt);
  });

  it("retains the independently computed v1 content identity", async () => {
    const value = await fixture();
    const input = `boundary.package-content/v1\0${JSON.stringify({
      version: 1,
      algorithm: "sha256",
      package: identity,
      files: value.content.files,
    })}`;
    expect(value.content.aggregateDigest).toBe(
      `sha256:${createHash("sha256").update(input).digest("hex")}`,
    );
  });

  it("distinguishes reused versions, exports, runtime floors, and supplied declaration changes", async () => {
    const before = await fixture();
    const after = await fixture({
      code: "export const result = 2;\n",
      exports: { ".": "./index.js", "./artifact": "./program.js", "./program": null },
      engines: { node: ">=26.0", bun: ">=1.3" },
    });
    const contract: InteractionContract = {
      version: 1,
      id: "documents.update",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      outputSchema: { type: "boolean" },
      reads: ["documents"],
      changes: ["documents"],
    };
    const report = await comparePackageArtifacts({
      before: { root: before.root },
      after: { root: after.root },
      requiredExports: ["./program", ".", "./program"],
      contracts: [{ before: contract, after: { ...contract, reads: ["accounts", "documents"] } }],
    });
    expect(report.identity).toEqual({
      sameName: true, sameVersion: true, sameContent: false,
      sameTarball: null, versionReusedWithDifferentContent: true,
    });
    expect(report.files.changed).toEqual(["index.js", "package.json"]);
    expect(report.exports).toEqual({
      added: ["./artifact"], removed: [], changed: ["./program"], unchanged: ["."],
      required: [".", "./program"], missingBefore: [], missingAfter: ["./program"],
    });
    expect(report.before.metadata.engines.node).toBe(">=24.21");
    expect(report.after.metadata.engines.node).toBe(">=26.0");
    expect(report.runtimes).toEqual({ added: ["bun"], removed: [], changed: ["node"], unchanged: [] });
    expect(report.contracts.source).toBe("caller-supplied");
    expect(report.contracts.deltas[0]?.delta).toMatchObject({
      changes: [{ path: "reads", kind: "changed", before: ["documents"], after: ["accounts", "documents"] }],
      existingCallers: { compatible: false },
    });
    expect(Object.isFrozen(report.after.content.files)).toBe(true);
    expect(Object.isFrozen(report.after.metadata.exports)).toBe(true);
    expect(Object.isFrozen(report.contracts.deltas[0]?.delta.changes)).toBe(true);
  });

  it("links verified receipts to content while keeping omitted tarball evidence unknown", async () => {
    const value = await fixture();
    const packed = await receiptFor(value);
    const source = {
      root: value.root,
      receiptPath: packed.receiptPath,
      expected: { ...identity, aggregateDigest: value.content.aggregateDigest, tarballDigest: packed.receipt.tarball.sha256 },
    };
    const report = await comparePackageArtifacts({ before: source, after: source });
    expect(report.identity.sameTarball).toBe(true);
    expect(report.before.receipt).toEqual(packed.receipt);
    expect((await comparePackageArtifacts({ before: source, after: { root: value.root } })).identity.sameTarball).toBeNull();
    await expect(comparePackageArtifacts({
      before: { root: value.root, expected: { tarballDigest: packed.receipt.tarball.sha256 } }, after: source,
    })).rejects.toThrow(/tarball digest requires an explicit receiptPath/);
  });

  it("reports distinct tarball encodings independently of identical verified content", async () => {
    const before = await fixture();
    const after = await fixture();
    const first = await receiptFor(before, "first archive encoding");
    const second = await receiptFor(after, "other archive encoding");
    const report = await comparePackageArtifacts({
      before: { root: before.root, receiptPath: first.receiptPath },
      after: { root: after.root, receiptPath: second.receiptPath },
    });
    expect(report.identity.sameContent).toBe(true);
    expect(report.identity.sameTarball).toBe(false);
  });

  it("rejects tampered files, stale pins, receipt/content disagreement, and tarball tampering", async () => {
    const value = await fixture();
    const other = await fixture({ code: "export const result = 9;\n" });
    const packed = await receiptFor(value);
    const source = { root: value.root, receiptPath: packed.receiptPath };
    await expect(comparePackageArtifacts({ before: source, after: { root: other.root, receiptPath: packed.receiptPath } })).rejects.toThrow(/receipt does not identify/);
    await expect(comparePackageArtifacts({ before: source, after: { ...source, expected: { aggregateDigest: missingDigest } } })).rejects.toThrow(/aggregate digest does not match/);
    await expect(comparePackageArtifacts({ before: source, after: { ...source, expected: { tarballDigest: missingDigest } } })).rejects.toThrow(/reviewed expected pin/);
    await writeFile(path.join(value.root, "example-service-1.0.0.tgz"), "tamper bytes");
    await expect(comparePackageArtifacts({ before: source, after: source })).rejects.toThrow(/tarball SHA-256/);
    await writeFile(path.join(value.root, "example-service-1.0.0.tgz"), "packed bytes");
    await writeFile(path.join(value.root, "index.js"), "export const result = 8;\n");
    await expect(comparePackageArtifacts({ before: source, after: source })).rejects.toThrow(/package file does not match/);
  });

  it("does not infer export requirements, semver compatibility, or declarations", async () => {
    const value = await fixture({ exports: { "./conditional": { node: "./index.js", browser: null }, "./features/*": "./*.js" } });
    const report = await comparePackageArtifacts({ before: value, after: value, requiredExports: ["./conditional", "./features/hidden"] });
    expect(report.exports.missingAfter).toEqual(["./features/hidden"]);
    expect(report.contracts.deltas).toEqual([]);
    expect((await comparePackageArtifacts({ before: value, after: value })).exports.required).toEqual([]);
    await expect(comparePackageArtifacts({ before: value, after: value, requiredExports: ["./features/*"] })).rejects.toThrow(/explicit package export names/);
  });

  it("rejects invalid verified package metadata and ignores derived dependency trees", async () => {
    const invalid = await fixture({ engines: { node: 24 } });
    await expect(comparePackageArtifacts({ before: invalid, after: invalid })).rejects.toThrow(/engines.node/);
    const value = await fixture();
    await mkdir(path.join(value.root, "node_modules"));
    await writeFile(path.join(value.root, "node_modules", "derived.txt"), "local dependencies");
    const report = await comparePackageArtifacts({ before: value, after: value });
    expect(report.identity.sameContent).toBe(true);
    expect(report.files.unchanged).not.toContain("node_modules/derived.txt");
  });

  it("reads without writing, installing, or updating the supplied roots", async () => {
    const value = await fixture();
    const before = await Promise.all((await readdir(value.root)).map(async (name) => [name, await readFile(path.join(value.root, name), "utf8")]));
    await comparePackageArtifacts({ before: value, after: value });
    const after = await Promise.all((await readdir(value.root)).map(async (name) => [name, await readFile(path.join(value.root, name), "utf8")]));
    expect(after).toEqual(before);
  });
});
