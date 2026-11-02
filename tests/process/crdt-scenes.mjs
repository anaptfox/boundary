// Prove experimental CRDT subpaths from isolated consumers of the packed SDK.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "boundary-crdt-consumer-"));
const installedModules = JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules/.modules.yaml"), "utf8"));
const pnpmStore = path.dirname(installedModules.storeDir);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout ?? 90_000,
  });
}

function installedVersion(name) {
  return JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules", name, "package.json"), "utf8")).version;
}

function installConsumer(root, dependencies) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "boundary-crdt-packed-consumer",
    private: true,
    type: "module",
    dependencies,
  }, null, 2)}\n`);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts", "--store-dir", pnpmStore], { cwd: root });
}

function linkWorkspaceTool(consumerRoot, packageName) {
  const source = realpathSync(path.join(workspaceRoot, "node_modules", packageName));
  const destination = path.join(consumerRoot, "node_modules", packageName);
  if (existsSync(destination)) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(source, destination, "dir");
}

try {
  const publishRoot = path.join(workspaceRoot, "dist/boundary");
  if (!existsSync(path.join(publishRoot, "package.json"))) {
    throw new Error("Built packages are missing; run `just build-packages` first.");
  }
  const packedDirectory = path.join(temporaryRoot, "tarballs");
  mkdirSync(packedDirectory);
  const report = JSON.parse(run(process.execPath, [
    path.join(workspaceRoot, "scripts/build/pack-artifact.mjs"),
    "--root", publishRoot,
    "--output", packedDirectory,
  ], { capture: true }));
  assert.equal(report.package.name, "@foxworth/boundary");
  assert.ok(existsSync(report.tarball), "verified SDK tarball exists");

  const noPeers = path.join(temporaryRoot, "without-engines");
  installConsumer(noPeers, {
    "@foxworth/boundary": `file:${report.tarball}`,
    zod: installedVersion("zod"),
  });
  writeFileSync(path.join(noPeers, "root-only.mjs"), `
import assert from "node:assert/strict";
import { install, surface, defineInteraction } from "@foxworth/boundary";
assert.equal(typeof install, "function");
assert.equal(typeof surface, "function");
assert.equal(typeof defineInteraction, "function");
for (const [subpath, peer] of [["yjs", "yjs"], ["automerge", "@automerge/automerge"]]) {
  await assert.rejects(import(\`@foxworth/boundary/\${subpath}\`), error =>
    error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(peer),
    \`the \${subpath} entry should fail specifically because optional peer \${peer} is absent\`,
  );
}
console.log("Packed SDK root imports without optional CRDT peers; CRDT entries identify their missing peer.");
`);
  run(process.execPath, [path.join(noPeers, "root-only.mjs")], { cwd: noPeers });

  const withPeers = path.join(temporaryRoot, "with-engines");
  installConsumer(withPeers, {
    "@foxworth/boundary": `file:${report.tarball}`,
    "@automerge/automerge": installedVersion("@automerge/automerge"),
    yjs: installedVersion("yjs"),
    zod: installedVersion("zod"),
  });
  for (const tool of ["@types/node", "typescript", "tsx"]) linkWorkspaceTool(withPeers, tool);
  const exampleSource = path.join(workspaceRoot, "examples/concepts/typescript/crdt-scene");
  const exampleTarget = path.join(withPeers, "examples/crdt-scene");
  cpSync(exampleSource, exampleTarget, { recursive: true });

  run(process.execPath, [
    path.join(withPeers, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023",
    "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--allowImportingTsExtensions", "--types", "node",
    path.join(exampleTarget, "run.ts"),
    path.join(exampleTarget, "consumer.types.ts"),
  ], { cwd: withPeers });
  run(process.execPath, [
    path.join(withPeers, "node_modules/tsx/dist/cli.mjs"),
    path.join(exampleTarget, "run.ts"),
  ], { cwd: withPeers });

  console.log("Packed CRDT consumer typecheck and same-process native loopback replica proofs passed.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
