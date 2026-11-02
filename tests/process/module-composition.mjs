// Compile and execute the checked composition recipe from a packed SDK only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyContentManifest,
  verifyPackReceipt,
} from "../../packages/core/artifact/integrity.ts";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examplePath = "examples/snippets/typescript/module-composition.ts";
const fixturePaths = [
  "tests/fixtures/runtimes/module-composition.ts",
  "tests/fixtures/runtimes/module-composition.types.ts",
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout ?? 90_000,
    env: options.env ?? process.env,
  });
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// The proof runs on any Node the package supports: CI exercises both the
// pinned development Node and the engines floor.
function verifyNodeVersion() {
  const range = JSON.parse(readFileSync(path.join(workspaceRoot, "packages", "package.json"), "utf8")).engines.node;
  const floor = /^>=\s*(\d+)(?:\.(\d+))?/u.exec(range);
  assert.ok(floor, `unsupported engines.node range ${range}`);
  const [major, minor] = process.versions.node.split(".").map(Number);
  const [floorMajor, floorMinor] = [Number(floor[1]), Number(floor[2] ?? 0)];
  assert.ok(major > floorMajor || (major === floorMajor && minor >= floorMinor),
    `Node ${process.versions.node} is below the supported ${range}`);
}

/** Use an existing temporary installed-package consumer; never builds or installs. */
export async function proveModuleCompositionConsumer(consumerRoot, receiptPath) {
  verifyNodeVersion();
  assert.equal(typeof receiptPath, "string", "an explicit packed receipt is required");
  const consumer = realpathSync(consumerRoot);
  const packed = await verifyPackReceipt(receiptPath, { name: "@foxworth/boundary" });
  const installedRoot = realpathSync(path.join(consumer, "node_modules/@foxworth/boundary"));
  assert.ok(isWithin(consumer, installedRoot), "Boundary must resolve inside the temporary consumer");
  assert.ok(!isWithin(workspaceRoot, installedRoot), "Boundary must not resolve to workspace source");
  const content = await verifyContentManifest(installedRoot, {
    ...packed.receipt.package,
    aggregateDigest: packed.receipt.contentDigest,
  });
  const proofRoot = mkdtempSync(path.join(consumer, "module-composition-proof-"));
  try {
    for (const relative of [examplePath, ...fixturePaths]) {
      const destination = path.join(proofRoot, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(workspaceRoot, relative), destination);
    }
    const outputRoot = path.join(proofRoot, "compiled");
    // Emit fresh consumer code, checking copied examples and negative type laws
    // against normal package declarations without source paths or aliases.
    const files = run(process.execPath, [
      path.join(consumer, "node_modules/typescript/bin/tsc"),
      "--strict", "--skipLibCheck", "--target", "ES2023",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--rewriteRelativeImportExtensions", "--types", "node",
      "--rootDir", proofRoot, "--outDir", outputRoot, "--listFiles",
      path.join(proofRoot, examplePath),
      ...fixturePaths.map(relative => path.join(proofRoot, relative)),
    ], { cwd: proofRoot, capture: true });
    const checkedFiles = files.trim().split(/\r?\n/u);
    for (const filename of checkedFiles) {
      if (isWithin(workspaceRoot, filename) && !isWithin(path.join(workspaceRoot, "node_modules"), filename)) {
        throw new Error(`packed recipe typecheck reached workspace source: ${filename}`);
      }
    }
    assert.ok(checkedFiles.some(filename => filename.endsWith(`${path.sep}index.d.ts`) && isWithin(installedRoot, realpathSync(filename))),
      "typecheck must read the installed Boundary root declarations");
    const runtime = path.join(outputRoot, "tests/fixtures/runtimes/module-composition.js");
    run(process.execPath, [runtime], {
      cwd: proofRoot,
      env: {
        ...process.env,
        BOUNDARY_PACK_RECEIPT: path.resolve(receiptPath),
        BOUNDARY_PACKED_CONSUMER: consumer,
      },
    });
    const report = {
      installedRoot,
      package: content.package,
      tarball: packed.tarballPath,
      archiveDigest: packed.receipt.tarball.sha256,
      contentDigest: content.aggregateDigest,
      exampleDigest: `sha256:${createHash("sha256").update(readFileSync(path.join(proofRoot, examplePath))).digest("hex")}`,
      node: process.versions.node,
      typecheck: "passed",
      runtime: "passed",
    };
    console.log(JSON.stringify({ moduleComposition: report }, null, 2));
    return report;
  } finally {
    rmSync(proofRoot, { recursive: true, force: true });
  }
}

async function proveStandalone() {
  verifyNodeVersion();
  const rootManifest = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const expectedPnpm = rootManifest.packageManager.replace(/^pnpm@/u, "");
  assert.equal(run("pnpm", ["--version"], { capture: true }).trim(), expectedPnpm, `use pinned pnpm ${expectedPnpm}`);
  const publishRoot = path.join(workspaceRoot, "dist/boundary");
  if (!existsSync(path.join(publishRoot, "package.json"))) {
    throw new Error("Built packages are missing; run `just check` before this proof.");
  }
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "boundary-module-composition-consumer-"));
  try {
    const tarballs = path.join(temporaryRoot, "tarballs");
    mkdirSync(tarballs);
    const report = JSON.parse(run(process.execPath, [
      path.join(workspaceRoot, "scripts/build/pack-artifact.mjs"),
      "--root", publishRoot, "--output", tarballs,
    ], { capture: true }));
    const packed = await verifyPackReceipt(report.receipt, { name: "@foxworth/boundary" });
    await verifyContentManifest(publishRoot, {
      ...packed.receipt.package,
      aggregateDigest: packed.receipt.contentDigest,
    });
    const installedVersion = name => JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules", name, "package.json"), "utf8")).version;
    const consumer = path.join(temporaryRoot, "consumer");
    mkdirSync(consumer);
    writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({
      name: "boundary-module-composition-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@foxworth/boundary": `file:${packed.tarballPath}`,
        zod: installedVersion("zod"),
        typescript: installedVersion("typescript"),
        "@types/node": installedVersion("@types/node"),
      },
    }, null, 2)}\n`);
    // pnpm 12 reads this supported setting from YAML, not the old CLI override.
    writeFileSync(path.join(consumer, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
    const installedModules = JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules/.modules.yaml"), "utf8"));
    run("pnpm", ["install", "--prefer-offline", "--ignore-scripts", "--store-dir", path.dirname(installedModules.storeDir)], { cwd: consumer });
    const result = await proveModuleCompositionConsumer(consumer, report.receipt);
    console.log(JSON.stringify({
      sourceObservedAtProof: {
        commit: run("git", ["rev-parse", "HEAD"], { capture: true }).trim(),
        dirty: run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { capture: true }).trim() !== "",
        note: "Current source state is separate from archive identity; this driver does not rebuild the package.",
      },
      archiveDigest: result.archiveDigest,
      contentDigest: result.contentDigest,
      pnpm: expectedPnpm,
      temporaryConsumerRemovedAfterProof: true,
    }, null, 2));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await proveStandalone();
}
