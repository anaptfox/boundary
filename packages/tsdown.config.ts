// Builds @foxworth/boundary into packages/dist with tsdown (rolldown + tsgo
// declarations). The source `exports` map in package.json lists every public
// subpath against its .ts source; tsdown keeps that map pointing at source for
// the workspace and writes the built paths to `publishConfig.exports`, which
// pnpm applies when packing. Entries whose built graph imports a `node:`
// builtin publish only a `node` condition.
import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const entryName = (key: string) => (key === "." ? "index" : key.slice(2));
const sourceEntries = Object.fromEntries(
  Object.entries(manifest.exports as Record<string, string | Record<string, string>>)
    .map(([key, target]) => [key, typeof target === "string" ? target : target.default ?? target.node])
    .filter(([key, target]) => key !== "./package.json" && typeof target === "string" && /\.tsx?$/u.test(target))
    .map(([key, target]) => [entryName(key), (target as string).replace(/^\.\//u, "")]),
);
// Non-code public files: subpath -> source path. tsdown regenerates `exports`
// from the entries, so these are added back in both maps by customExports.
const staticExports: Record<string, string> = { "./react/styles.css": "callers/react/styles.css" };

type Chunk = { type: string; fileName: string; name?: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; code?: string };

function nodeOnlyEntries(chunks: readonly Chunk[]): Set<string> {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const reachesNode = (chunk: Chunk, seen = new Set<string>()): boolean => {
    if (seen.has(chunk.fileName)) return false;
    seen.add(chunk.fileName);
    const imported = [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])];
    if (imported.some((id) => id.startsWith("node:"))) return true;
    return imported.some((id) => byFile.has(id) && reachesNode(byFile.get(id)!, seen));
  };
  return new Set(chunks.filter((chunk) => chunk.isEntry && chunk.name && reachesNode(chunk)).map((chunk) => chunk.name!));
}

// The plugin starts its executor with `new Worker(new URL("./plugin-worker.ts",
// import.meta.url))`. The worker is built as an internal entry next to the
// plugin chunks and the URL is rewritten to the built file; it is not exported.
const WORKER_SOURCE = 'new URL("./plugin-worker.ts", import.meta.url)';
const WORKER_BUILT = 'new URL("./plugin-worker.js", import.meta.url)';

export default defineConfig({
  entry: { ...sourceEntries, "plugin-worker": "guests/plugin/plugin-worker.ts" },
  plugins: [
    {
      name: "boundary-plugin-worker-url",
      renderChunk(code) {
        return code.includes(WORKER_SOURCE) ? code.replaceAll(WORKER_SOURCE, WORKER_BUILT) : null;
      },
    },
  ],
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  tsconfig: "tsconfig.build.json",
  sourcemap: false,
  clean: true,
  deps: { neverBundle: [/^@foxworth\/boundary(?:\/|$)/u, /^node:/u] },
  outputOptions: {
    banner: (chunk) => (chunk.name === "react" ? '"use client";' : ""),
  },
  copy: Object.entries(staticExports).map(([key, source]) => ({
    from: source,
    to: `dist/${key.slice(2).split("/").slice(0, -1).join("/")}`,
  })),
  exports: {
    devExports: true,
    exclude: ["plugin-worker"],
    customExports(exports, { chunks, isPublish }) {
      for (const [key, source] of Object.entries(staticExports)) {
        exports[key] = isPublish ? `./dist/${key.slice(2)}` : `./${source}`;
      }
      if (!isPublish) return exports;
      const nodeOnly = nodeOnlyEntries((chunks.es ?? []) as Chunk[]);
      for (const [key, target] of Object.entries(exports)) {
        if (!nodeOnly.has(entryName(key))) continue;
        const file = typeof target === "string" ? target : (target as Record<string, string>).default ?? (target as Record<string, string>).import;
        exports[key] = { types: file.replace(/\.js$/u, ".d.ts"), node: file };
      }
      return exports;
    },
  },
  // Package checks on the packed result. Any finding fails the build.
  publint: true,
  attw: { profile: "esm-only", level: "error", excludeEntrypoints: ["./react/styles.css"] },
  failOnWarn: true,
  // "use client" is re-added to the React entry by the banner below.
  suppressWarnings: [/TypeScript 7\.0 does not yet have a stable API/u, /module level directive "use client"/u],
});
