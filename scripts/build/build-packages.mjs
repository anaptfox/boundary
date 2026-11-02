// Build and stage @foxworth/boundary.
//
// 1. tsdown builds packages/dist (packages/tsdown.config.ts): JavaScript,
//    bundled declarations, publishConfig.exports, and publint/attw checks.
// 2. Boundary's own output checks run on packages/dist.
// 3. `pnpm pack` applies publishConfig and the `files` list; the tarball is
//    unpacked into dist/boundary, the staged package every later step uses.
// 4. A content manifest records every staged file for receipts and verification.
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeContentManifest } from "../../packages/core/artifact/integrity.ts";
import { moduleSpecifiers } from "../check/module-graph.mjs";
import { ARTIFACT_ROOT, WORKSPACE_ROOT } from "./sdk.ts";

const packageRoot = path.join(WORKSPACE_ROOT, "packages");
const builtRoot = path.join(packageRoot, "dist");
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function isBareImport(id) {
  return !(id.startsWith(".") || id.startsWith("/") || id.startsWith("\0") || id.startsWith("#"));
}

async function filesUnder(root, pattern) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file, pattern)));
    else if (pattern.test(entry.name)) files.push(file);
  }
  return files;
}

// Consumers type-check these files with their own resolver. A relative
// specifier that names a directory or a missing file degrades to `any` (or an
// error without skipLibCheck), so every one must resolve to an emitted file.
async function assertResolvableDeclarations(root) {
  const failures = [];
  for (const file of await filesUnder(root, /\.d\.ts$/u)) {
    for (const specifier of moduleSpecifiers(file, await readFile(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".d.ts"));
      if (!specifier.endsWith(".js") || !existsSync(target)) failures.push(`${path.relative(root, file)}: ${specifier}`);
    }
  }
  if (failures.length > 0) throw new Error(`Unresolvable declaration imports:\n${failures.join("\n")}`);
}

// Package-private `#` imports resolve only inside this source tree; the
// published package has no "imports" map, so none may survive into output.
async function assertNoPrivateImports(root) {
  const leaks = [];
  for (const file of await filesUnder(root, /\.(?:js|d\.ts)$/u)) {
    if (moduleSpecifiers(file, await readFile(file, "utf8")).some((s) => s.startsWith("#"))) {
      leaks.push(path.relative(root, file));
    }
  }
  if (leaks.length > 0) throw new Error(`Package-private imports leaked into output:\n${leaks.join("\n")}`);
}

// Every bare import in output must be the package itself, a Node builtin, or
// a declared dependency or peer.
async function assertDeclaredImports(root, declared) {
  for (const file of await filesUnder(root, /\.(?:js|d\.ts)$/u)) {
    for (const specifier of moduleSpecifiers(file, await readFile(file, "utf8"))) {
      if (!isBareImport(specifier) || builtins.has(specifier)) continue;
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!declared.has(name)) throw new Error(`${file} imports undeclared package ${name}`);
    }
  }
}

execFileSync("pnpm", ["exec", "tsdown"], { cwd: packageRoot, stdio: ["ignore", "inherit", "inherit"] });

const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
await assertResolvableDeclarations(builtRoot);
await assertNoPrivateImports(builtRoot);
await assertDeclaredImports(
  builtRoot,
  new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]),
);

const packDirectory = await mkdtemp(path.join(tmpdir(), "boundary-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: packageRoot, stdio: ["ignore", "ignore", "inherit"] });
  const [tarball] = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");
  await rm(ARTIFACT_ROOT, { recursive: true, force: true });
  execFileSync("mkdir", ["-p", ARTIFACT_ROOT]);
  execFileSync("tar", ["-xzf", path.join(packDirectory, tarball), "-C", ARTIFACT_ROOT, "--strip-components=1"]);
} finally {
  await rm(packDirectory, { recursive: true, force: true });
}

const staged = JSON.parse(await readFile(path.join(ARTIFACT_ROOT, "package.json"), "utf8"));
const content = await writeContentManifest(ARTIFACT_ROOT, { name: staged.name, version: staged.version });
process.stdout.write(`${JSON.stringify({
  version: 1,
  artifacts: [{ name: staged.name, version: staged.version, exports: Object.keys(staged.exports), contentDigest: content.aggregateDigest }],
}, null, 2)}\n`);
