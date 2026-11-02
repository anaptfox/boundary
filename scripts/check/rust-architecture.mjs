#!/usr/bin/env node
// Rust architectural boundaries.
//
// Replaces an inline shell check that banned runtime dependencies across every
// crate under `crates/`. That was correct while every crate was a published
// library law. The composition crates deliberately embed a WebAssembly runtime,
// sockets, and an HTTP transport, so the ban now applies per tier and the tier
// list is reviewed data in config/rust-crate-tiers.json.
//
// Invariants:
//   1. Every workspace member appears in exactly one tier.
//   2. A tier's banned dependencies are absent from its members.
//   3. Dependency direction follows the tier's `mayDependOn`. The pure tier
//      never depends on a crate that embeds a runtime.
//   4. A tier with a declared MSRV has members that inherit it.
//   5. No production source file exceeds the line limit.
//   6. No production source file re-exports with `pub use …::*`: every public
//      name is listed where it is exported, so a submodule cannot widen the API.
//   7. The Rust workspace version equals the npm package version: one release family.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tiersPath = join(root, "config", "rust-crate-tiers.json");
const config = JSON.parse(readFileSync(tiersPath, "utf8"));
const failures = [];

/** Minimal TOML reads for the exact fields this check needs. */
function packageName(toml) {
  return toml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function declaresWorkspaceRustVersion(toml) {
  return /^\s*rust-version\s*\.\s*workspace\s*=\s*true/m.test(toml);
}

function explicitRustVersion(toml) {
  return toml.match(/^\s*rust-version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** Dependency table entries, ignoring `[workspace.dependencies]` in the root. */
function dependencyNames(toml) {
  const names = new Set();
  const sections = toml.split(/^\[/m);
  for (const section of sections) {
    if (!/^(dependencies|dev-dependencies|build-dependencies|target\.[^\]]*\.dependencies)\]/.test(section)) {
      continue;
    }
    const body = section.slice(section.indexOf("]") + 1);
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*[=.]/);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

function workspaceMembers() {
  const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
  const block = toml.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const tierOf = new Map();
for (const [tier, spec] of Object.entries(config.tiers)) {
  for (const member of spec.members) {
    if (tierOf.has(member)) {
      failures.push(`${member}: listed in both ${tierOf.get(member)} and ${tier}`);
    }
    tierOf.set(member, tier);
  }
}

const crates = new Map();
for (const memberPath of workspaceMembers()) {
  const manifestPath = join(root, memberPath, "Cargo.toml");
  const toml = readFileSync(manifestPath, "utf8");
  const name = packageName(toml);
  if (!name) {
    failures.push(`${memberPath}: no package name`);
    continue;
  }
  crates.set(name, { memberPath, toml, deps: dependencyNames(toml) });
}

// 1. Every member is classified, and every classification is a real member.
for (const name of crates.keys()) {
  if (!tierOf.has(name)) {
    failures.push(
      `${name}: not classified in config/rust-crate-tiers.json. Add it to a tier before adding it to the workspace.`,
    );
  }
}
for (const name of tierOf.keys()) {
  if (!crates.has(name)) {
    failures.push(`${name}: classified in a tier but absent from the workspace members`);
  }
}

for (const [name, crate] of crates) {
  const tier = tierOf.get(name);
  if (!tier) continue;
  const spec = config.tiers[tier];

  // 2. Banned dependencies for this tier.
  for (const banned of spec.bannedDependencies) {
    if (crate.deps.has(banned)) {
      failures.push(`${name} (${tier}): forbidden dependency "${banned}"`);
    }
  }

  // 3. Dependency direction between tiers.
  for (const dep of crate.deps) {
    const depTier = tierOf.get(dep);
    if (!depTier) continue;
    if (!spec.mayDependOn.includes(depTier)) {
      failures.push(`${name} (${tier}): may not depend on ${dep} (${depTier})`);
    }
  }

  // 4. MSRV inheritance. The pure tier inherits the workspace value; any tier
  //    with a different declared MSRV must say so explicitly in its manifest.
  if (spec.rustVersion) {
    const explicit = explicitRustVersion(crate.toml);
    const inherits = declaresWorkspaceRustVersion(crate.toml);
    const workspaceRust = config.tiers.pure.rustVersion;
    if (spec.rustVersion === workspaceRust) {
      if (!inherits && explicit !== workspaceRust) {
        failures.push(`${name} (${tier}): must declare rust-version.workspace = true`);
      }
    } else if (explicit !== spec.rustVersion) {
      failures.push(
        `${name} (${tier}): must declare rust-version = "${spec.rustVersion}", found ${explicit ?? "workspace inheritance"}`,
      );
    }
  }
}

// 5. Deep-module size limit across production sources.
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "target") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".rs")) {
      out.push(full);
    }
  }
  return out;
}

const cratesDir = join(root, "crates");
for (const file of sourceFiles(cratesDir)) {
  // Production sources only. Relative, because the checkout itself may live
  // under a path containing "src".
  const rel = relative(root, file);
  if (!rel.split("/").includes("src")) continue;
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n").length;
  if (lines > config.lineLimit) {
    failures.push(`${rel}: ${lines} lines exceeds ${config.lineLimit}`);
  }
  for (const match of source.matchAll(/^\s*pub(?:\([^)]*\))?\s+use\s+[^;]*::\*\s*;/gmu)) {
    const line = source.slice(0, match.index).split("\n").length;
    failures.push(`${rel}:${line}: glob re-export; list the exported names`);
  }
}

{
  const workspaceVersion = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/u.exec(readFileSync(join(root, "Cargo.toml"), "utf8"))?.[1];
  const npmVersion = JSON.parse(readFileSync(join(root, "packages", "package.json"), "utf8")).version;
  if (workspaceVersion !== npmVersion) {
    failures.push(`Cargo workspace version ${workspaceVersion} differs from @foxworth/boundary ${npmVersion}`);
  }
}

if (failures.length > 0) {
  console.error("Rust architecture check failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`\n${failures.length} violation(s). Tiers: ${tiersPath}`);
  process.exit(1);
}

const counts = Object.entries(config.tiers)
  .map(([tier, spec]) => `${spec.members.length} ${tier}`)
  .join(", ");
console.log(`✓ rust architecture — ${crates.size} crates (${counts})`);
