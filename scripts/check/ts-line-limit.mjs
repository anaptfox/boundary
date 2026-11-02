#!/usr/bin/env node
// Production TypeScript files may not exceed the 500-line limit the Rust
// architecture gate enforces. Tests are excluded. Files already over the limit
// are listed with their current size as a ceiling: they may shrink, never grow,
// and a file that drops under the limit must leave the list. Every entry below
// has one job (type declarations, or one record family), so its size is
// accepted rather than owed; split a file when it gains a second job.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const limit = 500;
const oversized = new Map([
  ["packages/core/control/types.ts", 623],
  ["packages/core/host/types.ts", 568],
  ["packages/core/control/records.ts", 505],
]);
const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(path);
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) continue;
    const file = relative(root, path).split("\\").join("/");
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    const ceiling = oversized.get(file);
    if (ceiling === undefined && lines > limit) {
      failures.push(`${file}: ${lines} lines (limit ${limit})`);
    } else if (ceiling !== undefined && lines > ceiling) {
      failures.push(`${file}: ${lines} lines grew past its recorded ${ceiling}`);
    } else if (ceiling !== undefined && lines <= limit) {
      failures.push(`${file}: now ${lines} lines; remove it from the oversized list`);
    }
  }
}

for (const group of ["core", "discovery", "guests", "callers", "adapters"]) {
  walk(join(root, "packages", group));
}
for (const file of oversized.keys()) {
  if (!existsSync(join(root, file))) failures.push(`${file}: listed as oversized but no longer exists`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`✓ TypeScript production files are within the ${limit}-line limit (${oversized.size} recorded exceptions)`);
