/** Incremental guest builds. A hit skips construction, never validation or E2E tests. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guests = {
  js: { directory: "javascript", output: "thumbnail.component.wasm" },
  python: { directory: "python", output: "thumbnail.component.wasm" },
  go: { directory: "go", output: "thumbnail.component.wasm" },
} as const;
export type CachedGuest = keyof typeof guests;
const generated = new Set([
  "node_modules", "target", "out", "gen", ".venv", "__pycache__", ".git",
  "thumbnail.component.wasm", "thumbnail.core.wasm", "thumbnail.embed.wasm",
  "wit_world", "componentize_py_async_support", "poll_loop.py", "componentize_py_types.py",
  "componentize_py_runtime.pyi", "wit_bindings.go", "boundary_guest_footprints", "wit_runtime", "wit_types",
]);
const commonInputs = [
  "scripts/wasm/guests.sh", "scripts/wasm/build-cache.ts", "config/wasm-versions.json",
  ".node-version", "pnpm-lock.yaml",
];
function guest(root: string, row: CachedGuest) {
  const config = guests[row];
  if (config === undefined) throw new Error(`guest build cache does not support ${row}`);
  const directory = join(root, "examples/guests/thumbnail", config.directory);
  return { directory, artifact: join(directory, config.output), record: join(root, "target/guest-build-cache", `${row}.json`) };
}
function sources(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (generated.has(entry.name) || entry.name.endsWith(".pyc")) return [];
      const path = join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`guest cache requires ordinary source files: ${path}`);
      return entry.isDirectory() ? sources(directory, path) : [path];
    });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function buildKey(root: string, row: CachedGuest, toolIdentity: string): string {
  const { directory } = guest(root, row);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ row, toolIdentity, platform: process.platform, arch: process.arch, node: process.version }));
  for (const path of commonInputs) {
    hash.update(JSON.stringify([path, digest(readFileSync(join(root, path)))]));
  }
  for (const path of sources(directory)) {
    hash.update(JSON.stringify([path, digest(readFileSync(join(directory, path)))]));
  }
  return hash.digest("hex");
}
export function cacheHit(root: string, row: CachedGuest, key: string): boolean {
  const { record, artifact } = guest(root, row);
  if (!existsSync(record) || !existsSync(artifact)) return false;
  let value: { version?: number; key?: string; artifact?: string };
  try { value = JSON.parse(readFileSync(record, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  return value !== null && value.version === 1 && value.key === key
    && value.artifact === digest(readFileSync(artifact));
}
export function recordBuild(root: string, row: CachedGuest, key: string, toolIdentity: string): void {
  if (buildKey(root, row, toolIdentity) !== key) throw new Error("guest inputs changed during build; rerun before caching");
  const { record, artifact } = guest(root, row);
  if (statSync(artifact).size === 0) throw new Error("guest build produced an empty component");
  mkdirSync(dirname(record), { recursive: true });
  const temporary = `${record}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, key, artifact: digest(readFileSync(artifact)) })}\n`);
  renameSync(temporary, record);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, row, key, toolIdentity] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (row === undefined || !(row in guests)) throw new Error("expected js, python, or go");
  const name = row as CachedGuest;
  if (command === "key") process.stdout.write(buildKey(root, name, key ?? ""));
  else if (command === "hit") process.exitCode = cacheHit(root, name, key ?? "") ? 0 : 1;
  else if (command === "record") recordBuild(root, name, key ?? "", toolIdentity ?? "");
  else throw new Error("expected key, hit, or record");
}
