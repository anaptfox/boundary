#!/usr/bin/env node
// Report the pinned WebAssembly component toolchain and whether this machine
// has it. A component toolchain spans independently versioned tools; a
// mismatch surfaces as bindgen drift rather than a clean error, so the pins in
// config/wasm-versions.json are checked rather than assumed.
//
//   node ./scripts/check/wasm-toolchain.mjs            report only, never fails
//   node ./scripts/check/wasm-toolchain.mjs --strict    fail on any mismatch
//   node ./scripts/check/wasm-toolchain.mjs --install   install missing or mismatched CLI tools

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pins = JSON.parse(readFileSync(join(root, "config", "wasm-versions.json"), "utf8"));
const tiers = JSON.parse(readFileSync(join(root, "config", "rust-crate-tiers.json"), "utf8"));
const strict = process.argv.includes("--strict");
const install = process.argv.includes("--install");

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** First dotted version in a tool's output. */
function version(text) {
  return text?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

const checks = [
  { name: "wasm-tools", want: pins.cli.wasmTools, probe: () => version(run("wasm-tools", ["--version"])), cargo: "wasm-tools" },
  { name: "wit-bindgen", want: pins.cli.witBindgenCli, probe: () => version(run("wit-bindgen", ["--version"])), cargo: "wit-bindgen-cli" },
  { name: "cargo-component", want: pins.cli.cargoComponent, probe: () => version(run("cargo-component", ["--version"])), cargo: "cargo-component" },
  { name: "componentize-py", want: pins.cli.componentizePy, probe: () => version(run("componentize-py", ["--version"])), python: "componentize-py" },
  { name: "jco", want: pins.cli.jco, probe: () => version(run(join(root, "packages/node_modules/.bin/jco"), ["--version"])), npm: "@bytecodealliance/jco" },
  { name: "tinygo", want: pins.go.tinygo, probe: () => version(run("tinygo", ["version"])), manual: "https://tinygo.org/getting-started/install/" },
  { name: "go", want: pins.go.toolchain.slice(2), probe: () => version(run("env", [`GOTOOLCHAIN=${pins.go.toolchain}`, "go", "version"])), manual: "https://go.dev/dl/" },
  { name: "zig", want: pins.zig.version, probe: () => version(run("zig", ["version"])), manual: "https://ziglang.org/download/" },
];

const rustTargets = run("rustup", ["target", "list", "--installed"])?.split("\n") ?? [];

console.log(`Pinned component toolchain (resolved ${pins.resolvedOn})\n`);

let mismatched = 0;
let missing = 0;
for (const check of checks) {
  const found = check.probe();
  if (found === null) {
    missing += 1;
    console.log(`  ○ ${check.name.padEnd(12)} want ${check.want.padEnd(10)} not installed`);
  } else if (found !== check.want) {
    mismatched += 1;
    console.log(`  ✗ ${check.name.padEnd(12)} want ${check.want.padEnd(10)} found ${found}`);
  } else {
    console.log(`  ✓ ${check.name.padEnd(12)} ${found}`);
  }
}

console.log("");
for (const target of pins.rust.targets) {
  const present = rustTargets.includes(target);
  if (!present) missing += 1;
  console.log(`  ${present ? "✓" : "○"} rust target ${target}`);
}

console.log(`\n  wasmtime crate pin ${pins.rust.wasmtime} (needs Rust >=${tiers.tiers.composition.rustVersion}; the pure tier stays at ${tiers.tiers.pure.rustVersion})`);

if (install) {
  console.log("\nInstalling missing or mismatched tools…");
  for (const check of checks) {
    if (check.probe() === check.want) continue;
    if (check.cargo) {
      console.log(`  cargo install ${check.cargo}@${check.want}`);
      execFileSync("cargo", ["install", `${check.cargo}@${check.want}`, "--locked"], { stdio: "inherit" });
    } else if (check.python) {
      console.log(`  uv tool install --force ${check.python}==${check.want}`);
      execFileSync("uv", ["tool", "install", "--force", `${check.python}==${check.want}`], { stdio: "inherit" });
    } else if (check.npm) {
      console.log(`  ${check.npm}@${check.want} comes from the workspace; run pnpm install`);
    } else {
      console.log(`  ${check.name} must be installed manually: ${check.manual}`);
    }
  }
  for (const target of pins.rust.targets) {
    if (!rustTargets.includes(target)) {
      execFileSync("rustup", ["target", "add", target], { stdio: "inherit" });
    }
  }
  // Installation changes the evidence used by --strict. Recheck instead of
  // reporting pre-install mismatches as failures after a successful upgrade.
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...(strict ? ["--strict"] : [])], { stdio: "inherit" });
  process.exit(0);
}

if (strict && (mismatched > 0 || missing > 0)) {
  console.error(`\nblocked: ${mismatched} mismatched, ${missing} missing. Run: just wasm-tools-install`);
  process.exit(1);
}
