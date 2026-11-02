# Boundary command runner — https://just.systems
#
# Gate ladder (nested deps dedupe): quick ⊂ check ⊂ gate ⊂ ci ⊂ e2e
#   L1 quick  — docs + version family + TS types + Rust format/compile
#   L2 check  — TS/Rust tests + direct package build; agent done / pre-commit
#   L3 gate   — packed consumers + framework builds + strict Rust; pre-PR
#   L4 ci     — localhost transports + Rust docs + wasm core + reviewed vectors; acceptance
#   L5 e2e    — real runtimes and toolchains: guest matrix, Electron, Bun, workerd, Next. Needs them
#               installed, which is why it sits above ci rather than inside it.

# Show available recipes
default:
    @just --list

# =============================================================================
# Setup
# =============================================================================

# Install workspace dependencies
install:
    pnpm install

# First-time setup
bootstrap: install
    @echo "✓ bootstrap — next: just quick"

# =============================================================================
# Atomic quality
# =============================================================================

# Public documentation path, link, and positioning invariants
docs-check:
    pnpm docs:check

# Workspace TypeScript (no emit)
typecheck:
    pnpm typecheck

# TypeScript tests with in-process transports (no listening sockets)
test-unit:
    pnpm test

# Build the @foxworth/boundary package into dist/boundary
build:
    node ./scripts/build/build-packages.mjs

# Rust formatting (write)
rust-format:
    cargo fmt --all

# Rust formatting (check only)
rust-format-check:
    cargo fmt --all -- --check

# Compile every Rust target with default features
rust-compile:
    cargo check --workspace --all-targets --all-features --locked

# The Reach client alone, so features unified from test dependencies cannot mask its compile failures
rust-reach-client-compile:
    cargo check -p boundary-reach --lib --features client --locked

# Rust default-feature tests plus the optional Control lifecycle
rust-test-default:
    cargo test --workspace

# Strict Rust lint across every target and feature
rust-clippy:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

# Rust all-feature tests
rust-test-all-features:
    cargo test --workspace --all-features

# Core Rust laws without Schemars or derive conveniences
rust-test-no-default:
    cargo test -p boundary-core --no-default-features

# Rust crate tiers, dependency direction, per-tier MSRV, and module size limit
rust-architecture:
    node ./scripts/check/rust-architecture.mjs

# Verify the declared MSRV of the published pure tier only. Composition crates
# embed a WebAssembly runtime and sockets and declare their own higher floor;
# Warning-denied Rust documentation
rust-docs:
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps

# Verify the declared Rust 1.88 MSRV (opt-in; rustup may install it)
rust-msrv:
    cargo +1.88.0 test -p boundary-core -p boundary-macros --all-features
    cargo +1.88.0 clippy -p boundary-core -p boundary-macros --all-targets --all-features -- -D warnings

# =============================================================================
# WebAssembly component toolchain
# =============================================================================

# The pure core must keep compiling for both WebAssembly targets unchanged.
wasm-core-targets:
    cargo check -p boundary-core --features derive --target wasm32-unknown-unknown
    cargo check -p boundary-core --features derive --target wasm32-wasip1
    @echo "✓ core compiles for wasm32-unknown-unknown and wasm32-wasip1"

# Report the pinned component toolchain and whether each tool is present
wasm-tools-status:
    node ./scripts/check/wasm-toolchain.mjs

# Install the pinned component CLI tools (opt-in; network and time)
wasm-tools-install:
    node ./scripts/check/wasm-toolchain.mjs --install

# Guest matrix. Missing toolchains print blocked and exit 0; a row that did
# not run is never a pass. Implementation: scripts/wasm/guests.sh.
[private]
wasm-guest-status-reset:
    bash ./scripts/wasm/guests.sh reset

wasm-zig-guest:
    bash ./scripts/wasm/guests.sh zig

wasm-rust-guest:
    bash ./scripts/wasm/guests.sh rust

wasm-js-guest:
    bash ./scripts/wasm/guests.sh js

wasm-python-guest:
    bash ./scripts/wasm/guests.sh python

wasm-go-guest:
    bash ./scripts/wasm/guests.sh go

wasm-guest-summary:
    bash ./scripts/wasm/guests.sh summary

# End-to-end proof: one component per language realizes an interaction under an
# import map. The summary names every row that did not run.
wasm-guest-smoke: wasm-guest-status-reset wasm-zig-guest wasm-rust-guest wasm-js-guest wasm-python-guest wasm-go-guest wasm-guest-summary
    @echo "✓ guest matrix"

# The import-check fixtures are component binaries, and they are the
# input to the security boundary test. Rebuild them from the checked-in WIT
# and require the bytes to match: a fixture that was corrupted, staled, or
# swapped would otherwise change what "refused" means with nothing to notice.
fixtures-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v wasm-tools >/dev/null; then
      echo "blocked: verifying the import-check fixtures requires wasm-tools on PATH"
      exit 1
    fi
    root="tests/fixtures/wasm-imports"
    status=0
    for name in compliant overreach wasi import-shapes; do
      work=$(mktemp -d)
      wasm-tools component embed --dummy "$root/wit/$name" -o "$work/core.wasm"
      wasm-tools component new "$work/core.wasm" -o "$work/out.wasm"
      built=$(shasum -a 256 "$work/out.wasm" | cut -d' ' -f1)
      stored=$(shasum -a 256 "$root/$name.component.wasm" | cut -d' ' -f1)
      rm -rf "$work"
      if [ "$built" != "$stored" ]; then
        echo "  $name.component.wasm does not match its WIT: built $built, stored $stored"
        status=1
      fi
    done
    for name in aliased-imports instantiated-alias-imports outer-alias-imports component-argument-imports ascribed-alias-imports; do
      work=$(mktemp -d)
      wasm-tools parse "$root/$name.wat" -o "$work/out.wasm"
      wasm-tools validate --features component-model "$work/out.wasm"
      built=$(shasum -a 256 "$work/out.wasm" | cut -d' ' -f1)
      stored=$(shasum -a 256 "$root/$name.component.wasm" | cut -d' ' -f1)
      rm -rf "$work"
      if [ "$built" != "$stored" ]; then
        echo "  $name.component.wasm does not match its WAT: built $built, stored $stored"
        status=1
      fi
    done
    abi="tests/fixtures/plugin-import-abi"
    for wat in "$abi"/*.wat; do
      name=$(basename "$wat" .wat)
      work=$(mktemp -d)
      wasm-tools parse "$wat" -o "$work/out.wasm"
      # async-profile is valid only with component-model async enabled.
      features=component-model
      if [ "$name" = async-profile ]; then features=component-model,cm-async; fi
      wasm-tools validate --features "$features" "$work/out.wasm"
      built=$(shasum -a 256 "$work/out.wasm" | cut -d' ' -f1)
      stored=$(shasum -a 256 "$abi/$name.component.wasm" | cut -d' ' -f1)
      rm -rf "$work"
      if [ "$built" != "$stored" ]; then
        echo "  plugin-import-abi/$name.component.wasm does not match its WAT: built $built, stored $stored"
        status=1
      fi
    done
    if [ "$status" -ne 0 ]; then
      echo "fixtures differ from their sources; rebuild deliberately, never silently"
      exit 1
    fi
    echo "✓ import-check and import-ABI fixtures reproduce from their WIT/WAT"

# Each reviewed vector's positive cases are derivable from the implementation.
# Re-derive and compare — never rewrite. A vector is reviewed evidence: a gate
# may check it, and a gate that regenerates it proves only that the code
# agrees with itself.
vectors-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    check() {
      local package="$1" example="$2" vector="$3"
      local emitted
      emitted=$(cargo run -q -p "$package" --example "$example")
      if ! node -e '
        const fs = require("node:fs");
        // Compare by value, not by key order: a vector is pretty-printed for
        // a human reviewer, an emitter prints in struct order, and neither
        // ordering is the claim under test.
        const canonical = (value) =>
          Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.keys(value).sort().map((k) => [k, canonical(value[k])]),
                )
              : value;
        const emitted = canonical(JSON.parse(process.argv[1]));
        const reviewed = canonical(
          JSON.parse(fs.readFileSync(process.argv[2], "utf8")).cases,
        );
        if (JSON.stringify(emitted) !== JSON.stringify(reviewed)) {
          console.error(`  ${process.argv[3]} no longer derives ${process.argv[2]}`);
          process.exit(1);
        }
      ' "$emitted" "tests/conformance/v1/$vector" "$example"; then
        status=1
      fi
    }
    check boundary-plugin emit-vector-cases wasm-projection.json
    check boundary-reach emit-reach-cases reach.json
    check boundary-core emit-draft-cases draft.json
    if [ "$status" -ne 0 ]; then
      echo "a generator drifted from its reviewed vector; reconcile deliberately"
      exit 1
    fi
    echo "✓ reviewed vector cases are still derivable from the implementations"

# =============================================================================
# Local bus and the boundary binary
# =============================================================================

# Build the boundary command
boundary-build:
    cargo build -p boundary-cli
    @echo "✓ built target/debug/boundary — try: ./target/debug/boundary --help"

# Rust-only cumulative ladder
rust-quick: rust-format-check rust-compile rust-reach-client-compile
    @echo "✓ rust quick"

# Rust L2: format, compile, and the default-feature test suite
rust-check: rust-quick rust-test-default
    @echo "✓ rust check"

# Rust L3: adds strict lint, every feature combination, and the tier rules
rust-gate: rust-check rust-clippy rust-test-all-features rust-test-no-default rust-architecture
    @echo "✓ rust gate"

# Rust L4: adds warning-denied documentation
rust-ci: rust-gate rust-docs
    @echo "✓ rust ci"

# Packed direct-package consumer smoke
pack-smoke: build
    node ./tests/process/packed-packages.mjs

# Opt-in packed portable interfaces on Node and Bun; runtimes must be installed
portable-smoke: build
    node ./tests/process/packed-packages.mjs --portable-runtimes

# Real Hono, Cloudflare Worker/DO, and generated Next build proof
framework-smoke: build
    node ./tests/process/framework-adapters.mjs build

# Vite localhost mount over built packages
framework-live: build
    node ./tests/process/framework-adapters.mjs live

# Native application proofs (opt-in; local sockets and installed runtimes required)
next-native-smoke: build
    node ./tests/process/document-workspace.mjs

worker-native-smoke: build
    node ./tests/fixtures/runtimes/cloudflare-worker/run.mjs

# A real Durable Object over the built artifacts
durable-object-native-smoke: build
    node ./tests/fixtures/runtimes/durable-object/run.mjs

# A real Vite dev server mount over the built artifacts
vite-native-smoke: build
    node ./tests/fixtures/runtimes/vite/run.mjs

# Actual Electron process; a missing or blocked desktop runtime is not a pass
electron-native-smoke: build
    node ./tests/fixtures/runtimes/electron/run.mjs

# One build for the native matrix; does not imply completion of the demo suite
framework-native-smoke: next-native-smoke worker-native-smoke durable-object-native-smoke vite-native-smoke electron-native-smoke
    @echo "✓ framework native runtime proofs"

# Bun is scoped to this example; Next includes all three domain HTTP proofs.
persistent-bot-smoke: build
    node ./tests/process/persistent-bot.mjs

# Native browser bundle and SDK WebSocket consumer
websocket-room-smoke: build
    pnpm --dir examples/apps/typescript/websocket-room build
    pnpm exec vitest run --config config/vitest.live.config.ts tests/typescript/live/websocket-room.test.ts

# Bounded demo workflows
framework-demo-smoke: next-native-smoke persistent-bot-smoke websocket-room-smoke
    @echo "✓ bounded framework demo workflows"

# Electron HTTP and composition over real loopback sockets; Electron APIs are faked
test-transports:
    pnpm test:transports

# Localhost transport acceptance (requires loopback sockets)
test-live: framework-live test-transports
    @echo "✓ transports over real loopback sockets"

# Opt-in local timings. Not a gate, not a published claim.
bench:
    node ./scripts/perf/run.mjs

# Complete guest matrix timings, with logs and artifact digests; not a gate.
bench-guests label="run" rounds="2":
    node ./scripts/perf/guests.mjs {{ quote(label) }} {{ quote(rounds) }}

# Test-only TypeScript caller and native Rust host over framed stdio
rust-mcp-modern-smoke:
    cargo build -p boundary-mcp --example protocol_fixture
    node ./tests/process/rust-mcp-modern.mjs

# Build the standalone native C ABI library (shared and static).
native-abi-build:
    cargo build -p boundary-ffi

# Stage and relocate the public header and libraries; run native C/C++ consumers.
native-abi-smoke: native-abi-build
    node ./tests/process/native-abi.mjs

test-cross-language:
    cargo build -p boundary-core --example cross_language_todo --features derive
    node ./tests/typescript/cross-language/generate.mjs
    pnpm exec vitest run --config config/vitest.cross-language.config.ts

# Compare two just bench JSON reports. Defaults: baseline.json vs current.json
bench-compare before="" after="":
    node ./scripts/perf/compare.mjs {{ quote(before) }} {{ quote(after) }}

# In-process Todo MVP fixture: screen + agent on one Installation
example-todo-test:
    pnpm exec vitest run tests/typescript/todo-mvp.test.ts

# Optional Yjs and Automerge peers through isolated packed consumers and native loopback replicas
crdt-e2e: build
    node ./tests/process/crdt-scenes.mjs

# Packed inspector browser proof in Playwright headless Chromium (install once: just browsers)
# Download the headless Chromium build that the pinned Playwright expects
browsers:
    pnpm exec playwright install chromium-headless-shell

inspector-browser-e2e: build
    node ./tests/process/inspector-e2e.mjs

# Launch browser UI, Electron, MCP, and protocol doors together
example-todo:
    pnpm --filter @foxworth/boundary-example-todo-multisurface start

# =============================================================================
# Gate ladder
# =============================================================================

# L1 — agent inner loop after an edit batch
quick: docs-check typecheck lint rust-quick
    @echo "✓ quick"

# L2 — agent done / pre-commit (does not build the full fixture matrix)
check: quick test-unit test-scripts build api-surface rust-check ts-line-limit
    @echo "✓ check — pre-PR: just gate"

# Production TypeScript stays under the same 500-line limit Rust enforces
ts-line-limit:
    node ./scripts/check/ts-line-limit.mjs

# Tests for the repo's own scripts (node:test)
test-scripts:
    node --test ./tests/scripts/*.test.mjs

# JavaScript and TypeScript lint (oxlint; rules in .oxlintrc.json)
lint:
    pnpm exec oxlint --deny-warnings packages scripts tests examples

# The built public API matches tests/fixtures/api-surface.json (review diffs, then --write)
api-surface: build
    node ./scripts/check/api-surface.mjs

# L3 — pre-PR: packed artifacts + real framework builds + strict Rust
gate: check rust-mcp-modern-smoke native-abi-smoke pack-smoke framework-smoke rust-gate test-cross-language
    @echo "✓ gate — pre-merge: just ci"

# L4 — full acceptance, including localhost transport proofs
ci: gate test-live rust-ci wasm-core-targets fixtures-verify vectors-verify
    @echo "✓ ci — real-runtime proofs: just e2e"

# L5 — every proof that needs a real runtime or toolchain installed: the guest matrix, Electron, Bun,
# workerd, and a Next build. These are outside `ci` because a machine without
# those runtimes cannot run them, and a suite that cannot run must not be
# reported as one that passed.
e2e: ci wasm-guest-smoke framework-native-smoke framework-demo-smoke portable-smoke example-todo-test crdt-e2e inspector-browser-e2e
    @echo "✓ e2e — real runtimes proved"

# =============================================================================
# Pack / publish workflows
# =============================================================================
# release.yml stages releases through npm trusted publishing; a maintainer
# releases each one with npm stage approve and 2FA. No npm token exists.

# Pack the built package into a tarball and receipt
pack: build
    node ./scripts/build/pack-packages.mjs

# Pack and verify contents without writing tarballs
pack-check: build
    node ./scripts/build/pack-packages.mjs --check

# Online isolated smoke for the supported Zod peer range
zod-peer-smoke zod="4.6.5" candidate="release-candidate":
    node ./scripts/build/zod-peer-smoke.mjs --candidate {{ quote(candidate) }} --zod {{ quote(zod) }}

# Build the release candidate into release-candidate/ (clean tree required; never publishes)
release-candidate:
    node ./scripts/release/create-candidate.mjs

# Before npm stage approve: prove the staged tarball is a release.yml run's candidate
release-review stage run:
    node ./scripts/release/review.mjs {{ quote(stage) }} --run {{ quote(run) }}

# After npm stage approve: prove npm serves that candidate with valid signatures
release-verify run:
    node ./scripts/release/verify.mjs --run {{ quote(run) }}
