#!/usr/bin/env node
// Public API surface of the built SDK, derived from its emitted declarations.
//
// For every subpath in dist/boundary/package.json, parse the entry .d.ts with
// oxc and follow its export graph and record each exported name with its normalized declaration
// text. Moving a declaration between files leaves its text unchanged, so a
// pure refactor produces an identical surface; any added, removed, or changed
// export shows up as a reviewed diff against tests/fixtures/api-surface.json.
//
//   node scripts/check/api-surface.mjs           compare with the snapshot
//   node scripts/check/api-surface.mjs --write   rewrite the snapshot
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const artifactRoot = path.join(root, "dist", "boundary");
const snapshotPath = path.join(root, "tests", "fixtures", "api-surface.json");

/** Normalizes declaration text so location-only differences disappear. */
export function normalize(text) {
  return text
    // Whether a declaration carries `export`/`declare` inline or is exported
    // from a list elsewhere is a file-layout detail, not part of its API.
    .replace(/(^|\n)\s*(?:export\s+)?(?:declare\s+)?(?=(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\b)/gu, "$1")
    // Bundled declarations reference types by name or by renamed import alias
    // (`Name$1`); separate files reference them through relative import types.
    .replace(/import\((["'])\.{1,2}\/[^"']+\1\)\./gu, "")
    .replace(/([A-Za-z_][\w]*)\$\d+\b/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(/\s*([{}();,:<>|&=[\]])\s*/gu, "$1")
    .trim();
}

function declarationNames(node) {
  if (node.type === "VariableDeclaration") return node.declarations.map((d) => d.id.name);
  return node.id?.type === "Identifier" ? [node.id.name] : node.id?.name ? [node.id.name] : [];
}

/** Builds the export map of one declaration file: exported name -> declaration text. */
export function createSurfaceReader(readFile = (file) => readFileSync(file, "utf8")) {
  const cache = new Map();
  function moduleInfo(file) {
    if (cache.has(file)) return cache.get(file);
    const info = { declarations: new Map(), imports: new Map(), exports: [] };
    cache.set(file, info);
    const source = readFile(file);
    const { program, errors } = parseSync(file, source, { lang: "dts" });
    if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
    const declare = (names, node) => {
      const text = source.slice(node.start, node.end);
      for (const name of names) {
        const prior = info.declarations.get(name);
        info.declarations.set(name, prior ? `${prior}\n${text}` : text);
      }
    };
    for (const node of program.body) {
      if (node.type === "ImportDeclaration") {
        for (const s of node.specifiers ?? []) {
          info.imports.set(s.local.name, {
            from: node.source.value,
            name: s.type === "ImportNamespaceSpecifier" ? "*" : s.type === "ImportDefaultSpecifier" ? "default" : s.imported.name ?? s.imported.value,
          });
        }
      } else if (node.type === "ExportAllDeclaration") {
        info.exports.push(node.exported ? { local: "*", exported: node.exported.name, from: node.source.value } : { star: node.source.value });
      } else if (node.type === "ExportNamedDeclaration" && node.declaration) {
        const names = declarationNames(node.declaration);
        declare(names, node);
        for (const name of names) {
          if (!info.exports.some((e) => e.exported === name && e.declared)) info.exports.push({ local: name, exported: name, declared: true });
        }
      } else if (node.type === "ExportNamedDeclaration") {
        for (const s of node.specifiers) {
          info.exports.push({ local: s.local.name ?? s.local.value, exported: s.exported.name ?? s.exported.value, from: node.source?.value });
        }
      } else {
        declare(declarationNames(node), node);
      }
    }
    return info;
  }
  function resolveSpecifier(from, specifier) {
    if (!specifier.startsWith(".")) return undefined;
    return path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ".d.ts"));
  }
  function declarationOf(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return `<cycle ${name}>`;
    seen.add(key);
    const info = moduleInfo(file);
    if (info.declarations.has(name)) return normalize(info.declarations.get(name));
    const imported = info.imports.get(name);
    if (imported) {
      const target = resolveSpecifier(file, imported.from);
      return target ? declarationOf(target, imported.name, seen) : `<re-export ${imported.name} from ${imported.from}>`;
    }
    const surface = exportsOf(file, seen);
    if (name in surface) return surface[name];
    return `<unresolved ${name}>`;
  }
  function exportsOf(file, seen = new Set()) {
    const out = {};
    for (const entry of moduleInfo(file).exports) {
      if (entry.star !== undefined) {
        const target = resolveSpecifier(file, entry.star);
        if (target) Object.assign(out, exportsOf(target, seen));
        else out[`* from ${entry.star}`] = `<re-export * from ${entry.star}>`;
        continue;
      }
      if (entry.local === "*") {
        const target = resolveSpecifier(file, entry.from);
        out[entry.exported] = target
          ? `namespace{${Object.entries(exportsOf(target, seen)).map(([k, v]) => `${k}=${v}`).join(";")}}`
          : `<re-export * as ${entry.exported} from ${entry.from}>`;
      } else if (entry.from !== undefined) {
        const target = resolveSpecifier(file, entry.from);
        out[entry.exported] = target
          ? declarationOf(target, entry.local, new Set(seen))
          : `<re-export ${entry.local} from ${entry.from}>`;
      } else {
        out[entry.exported] = declarationOf(file, entry.local, new Set(seen));
      }
    }
    return out;
  }
  return { exportsOf };
}

function sorted(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function currentSurface() {
  const manifest = JSON.parse(readFileSync(path.join(artifactRoot, "package.json"), "utf8"));
  const reader = createSurfaceReader();
  const surface = {};
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === "./package.json") continue;
    const types = typeof target === "string"
      ? (target.endsWith(".js") ? target.replace(/\.js$/u, ".d.ts") : undefined)
      : target.types;
    if (types === undefined) {
      surface[subpath] = { "<file>": target };
      continue;
    }
    surface[subpath] = sorted(reader.exportsOf(path.join(artifactRoot, types)));
  }
  return surface;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(path.join(artifactRoot, "package.json"))) {
    console.error("blocked: dist/boundary is not built; run just build");
    process.exit(1);
  }
  const surface = currentSurface();
  const text = `${JSON.stringify(surface, null, 2)}\n`;
  const unresolved = text.match(/<unresolved [^>]+>|<cycle [^>]+>/gu) ?? [];
  if (unresolved.length > 0) {
    console.error(`API surface has unresolved names: ${[...new Set(unresolved)].join(", ")}`);
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    writeFileSync(snapshotPath, text);
    console.log(`wrote ${path.relative(root, snapshotPath)}`);
  } else {
    const reviewed = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
    if (reviewed !== text) {
      const before = reviewed ? JSON.parse(reviewed) : {};
      const changes = [];
      for (const subpath of new Set([...Object.keys(before), ...Object.keys(surface)])) {
        const a = before[subpath] ?? {};
        const b = surface[subpath] ?? {};
        for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (!(name in b)) changes.push(`- ${subpath} ${name}`);
          else if (!(name in a)) changes.push(`+ ${subpath} ${name}`);
          else if (a[name] !== b[name]) changes.push(`~ ${subpath} ${name}`);
        }
      }
      console.error(`API surface differs from tests/fixtures/api-surface.json (${changes.length}):\n${changes.slice(0, 80).join("\n")}`);
      console.error("Review the change, then run node scripts/check/api-surface.mjs --write");
      process.exit(1);
    }
    const names = Object.values(surface).reduce((n, s) => n + Object.keys(s).length, 0);
    console.log(`✓ API surface matches the reviewed snapshot (${Object.keys(surface).length} subpaths, ${names} exports)`);
  }
}
