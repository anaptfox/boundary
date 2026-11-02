// Public documentation invariants: docs/ front matter, links and anchors, the site
// manifest, embedded snippets, and documented exports.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];
const fail = (message) => failures.push(message);
const label = (file) => relative(root, file).split(sep).join("/");
const lineAt = (source, index) => source.slice(0, index).split("\n").length;
const read = (path) => readFileSync(resolve(root, path), "utf8");

function markdownUnder(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.name.endsWith(".md") ? [path.split(sep).join("/")] : [];
  });
}

// The public corpus is the root README plus everything under docs/.
const docs = markdownUnder("docs").sort();
const corpus = ["README.md", ...docs];
const markdownFiles = corpus.map((path) => resolve(root, path));
const linkedFiles = markdownFiles;

function parseFrontMatter(source) {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const fields = {};
  for (const line of source.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const match =
      /^(title|description):\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S.*))$/u.exec(
        line,
      );
    if (!match) return undefined;
    fields[match[1]] = (match[2] ?? match[3] ?? match[4]).replace(
      /\\(["'])/gu,
      "$1",
    );
  }
  return fields;
}

// docs/ pages carry front matter for the documentation site. The root README
// does not: GitHub renders front matter as a table above it.
for (const path of docs) {
  const source = read(path);
  const matter = parseFrontMatter(source);
  if (!matter?.title || !matter.description || Object.keys(matter).length !== 2) {
    fail(`${path}: missing YAML front matter with title and description`);
    continue;
  }
  if (source.match(/^# (.+)$/mu)?.[1].trim() !== matter.title) {
    fail(`${path}: front matter title must match the first heading`);
  }
}

function headingAnchors(source) {
  const counts = new Map();
  const anchors = new Set();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = match[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/<[^>]*>/gu, "")
      .replace(/[`*_~]/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

for (const file of linkedFiles) {
  const source = readFileSync(file, "utf8");
  const fileLabel = label(file);

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1].trim().replace(/^<|>$/gu, "");
    const hashIndex = rawTarget.indexOf("#");
    const targetPart = (hashIndex === -1
      ? rawTarget
      : rawTarget.slice(0, hashIndex)).split("?", 1)[0];
    const fragment = hashIndex === -1 ? "" : rawTarget.slice(hashIndex + 1);
    if (/^(?:file:|[A-Za-z]:[\\/]|\/)/iu.test(targetPart)) {
      fail(`${fileLabel}:${lineAt(source, match.index)} public documentation must use portable relative file links: ${rawTarget}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(targetPart)) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(targetPart);
    } catch {
      fail(`${fileLabel}:${lineAt(source, match.index)} malformed link target: ${rawTarget}`);
      continue;
    }
    const target = targetPart ? resolve(dirname(file), decoded) : file;
    const escapedRoot = target !== root && !target.startsWith(`${root}${sep}`);
    if (escapedRoot) {
      fail(`${fileLabel}:${lineAt(source, match.index)} link escapes the repository: ${rawTarget}`);
      continue;
    }
    const targetLabel = label(target);
    if (targetLabel === ".private" || targetLabel.startsWith(".private/")) {
      fail(`${fileLabel}:${lineAt(source, match.index)} public link crosses into local documentation: ${rawTarget}`);
      continue;
    }
    if (!existsSync(target)) {
      fail(`${fileLabel}:${lineAt(source, match.index)} missing link target: ${rawTarget}`);
      continue;
    }
    if (fragment && statSync(target).isFile() && /\.mdx?$/u.test(target)) {
      const anchors = headingAnchors(readFileSync(target, "utf8"));
      let decodedFragment;
      try {
        decodedFragment = decodeURIComponent(fragment).toLowerCase();
      } catch {
        fail(`${fileLabel}:${lineAt(source, match.index)} malformed link fragment: ${rawTarget}`);
        continue;
      }
      if (!anchors.has(decodedFragment)) {
        fail(`${fileLabel}:${lineAt(source, match.index)} missing heading fragment: ${rawTarget}`);
      }
    }
  }
}

// Every docs/ page is published exactly once with a unique route.
let site;
try {
  site = JSON.parse(read("docs/public-site.json"));
} catch (error) {
  fail(`docs/public-site.json: ${error.message}`);
}
if (site && (site.version !== 1 || !Array.isArray(site.pages))) {
  fail("docs/public-site.json: expected a version 1 pages manifest");
} else if (site) {
  const sources = new Set();
  const routes = new Set();
  for (const [index, page] of site.pages.entries()) {
    if (!docs.includes(page?.source)) {
      fail(`docs/public-site.json: pages[${index}].source is not a docs/ page: ${page?.source}`);
    } else if (sources.has(page.source)) {
      fail(`docs/public-site.json: duplicate source: ${page.source}`);
    }
    sources.add(page?.source);
    if (typeof page?.route !== "string" || page.route.length === 0) {
      fail(`docs/public-site.json: pages[${index}].route must be non-empty`);
    } else if (routes.has(page.route)) {
      fail(`docs/public-site.json: duplicate route: ${page.route}`);
    }
    routes.add(page?.route);
  }
  for (const path of docs) {
    if (!sources.has(path)) fail(`${path}: not listed in docs/public-site.json`);
  }
}

function normalizedSnippet(value) {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function sourceRegion(file, name) {
  const source = readFileSync(file, "utf8").replace(/\r\n?/gu, "\n");
  const start = `// #region ${name}`;
  const end = `// #endregion ${name}`;
  const startIndex = source.indexOf(start);
  const secondStart = source.indexOf(start, startIndex + start.length);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1 || secondStart !== -1) {
    return undefined;
  }
  const region = source.slice(source.indexOf("\n", startIndex) + 1, endIndex);
  const lines = region.replace(/\n+$/u, "").split("\n");
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/u)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(indent)).join("\n");
}

// Embedded TypeScript must match its executable source region exactly.
const usedExampleFiles = new Set();
const snippetPattern = /<!--\s*snippet:([^#\s>]+)#([A-Za-z0-9_-]+)\s*-->\s*\n```(?:ts|typescript)\n([\s\S]*?)\n```/gu;
for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  const fileLabel = label(file);
  const markers = [...source.matchAll(/<!--\s*snippet:[^>]+-->/gu)];
  const snippets = [...source.matchAll(snippetPattern)];
  if (markers.length !== snippets.length) {
    fail(`${fileLabel}: every snippet marker must be followed by a TypeScript fence`);
  }
  for (const match of snippets) {
    const [, sourcePath, region, embedded] = match;
    const at = `${fileLabel}:${lineAt(source, match.index)}`;
    const example = resolve(root, sourcePath);
    if (!example.startsWith(`${resolve(root, "examples/snippets/typescript")}${sep}`)) {
      fail(`${at} snippet source must be in examples/snippets/typescript`);
      continue;
    }
    if (!existsSync(example)) {
      fail(`${at} missing snippet source: ${sourcePath}`);
      continue;
    }
    const expected = sourceRegion(example, region);
    if (expected === undefined) {
      fail(`${at} missing or duplicate region: ${sourcePath}#${region}`);
    } else if (normalizedSnippet(embedded) !== normalizedSnippet(expected)) {
      fail(`${at} stale snippet: ${sourcePath}#${region}`);
    }
    usedExampleFiles.add(sourcePath);
  }
}

// These examples exist to be read; dropping their embedding hides drift.
for (const sourcePath of [
  "examples/snippets/typescript/module-composition.ts",
  "examples/snippets/typescript/host-lifecycle.ts",
  "examples/snippets/typescript/scene-authoring.ts",
  "examples/snippets/typescript/thumbnail.ts",
  "examples/snippets/typescript/document-review-interactions.ts",
  "examples/snippets/typescript/document-review.ts",
]) {
  if (!usedExampleFiles.has(sourcePath)) {
    fail(`${sourcePath}: executable example is not embedded in any public doc`);
  }
}

// Every public subpath is named somewhere a reader can find it.
const manifest = JSON.parse(read("packages/package.json"));
const exportText = [...corpus, "packages/README.md"].map(read).join("\n");
const exportCount = Object.keys(manifest.exports ?? {}).filter((key) => key !== "./package.json").length;
for (const key of Object.keys(manifest.exports ?? {}).filter((key) => key !== "./package.json")) {
  const specifier = key === "." ? manifest.name : `${manifest.name}/${key.replace(/^\.\//u, "")}`;
  if (!exportText.includes(`\`${specifier}\``) && !exportText.includes(`"${specifier}"`)) {
    fail(`docs: public package export is not documented: ${specifier}`);
  }
}


// packages/README.md carries a subpath table generated from the exports map.
{
  const readmePath = resolve(root, "packages/README.md");
  const readme = readFileSync(readmePath, "utf8");
  const start = "<!-- subpaths:start -->\n";
  const end = "<!-- subpaths:end -->";
  const rows = Object.entries(manifest.exports ?? {}).filter(([key]) => key !== "./package.json").map(([key, target]) => {
    const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`;
    const owner = target.slice(2).split("/").slice(0, 2).join("/");
    return `| \`${specifier}\` | \`${owner}\` | \`${target.slice(2)}\` |`;
  });
  const table = `| Import | Owner | Source |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to === -1) {
    fail("packages/README.md: missing subpath table markers");
  } else if (readme.slice(from + start.length, to) !== table) {
    if (process.argv.includes("--write")) {
      writeFileSync(readmePath, readme.slice(0, from + start.length) + table + readme.slice(to));
    } else {
      fail("packages/README.md: subpath table is stale; run node scripts/check/docs.mjs --write");
    }
  }
}

if (failures.length > 0) {
  console.error(`Documentation check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation check passed (${markdownFiles.length} Markdown files, ${usedExampleFiles.size} embedded examples, ${exportCount} SDK exports).`,
  );
}
