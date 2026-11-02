# Agent notes — Boundary

Boundary is one mixed-language monorepo with two native implementations:

- `packages/` is the single `@foxworth/boundary` TypeScript SDK. Its source
  modules are grouped under `core/`, `discovery/`, `guests/`, `callers/`, and
  `adapters/`. Each public subpath points directly to its owning module.
- `tests/typescript/` contains TypeScript in-process tests.
- `crates/` and `examples/concepts/rust/` contain the native Rust
  implementation and executable proofs. Rust tests live in `crates/*/tests/`.
- `tests/conformance/` contains reviewed portable evidence consumed
  independently by both languages.
- `tests/fixtures/` is the canonical home for checked-in test inputs and
  small runtime shapes.
- `tests/process/` contains tests that spawn a real build or runtime. They
  are not part of `pnpm test`.
- `scripts/` is repo composition: checks, package, release, perf, and the
  guest matrix.
- `README.md` and `docs/` are the canonical public documentation for the
  current product: reader education, TypeScript guides, reference, and the
  normative specification.

Sharing a repository does not make either implementation a wrapper around the
other. Production Rust must not import or execute TypeScript, and production
TypeScript must not load the Rust crate. Cross-language agreement belongs in
conformance tests; cross-process execution belongs behind an explicit Handoff
and a host-chosen transport.

A semantic change must update every affected implementation and, when it
changes a cross-language law, shared conformance evidence in the same reviewed
change. When implementations disagree, make the intended law explicit;
historical behavior has no silent veto.

## Quality ladder

Use the root `justfile` for composition. `pnpm run quick`, `pnpm run check`,
`pnpm run gate`, `pnpm run ci`, and `pnpm run e2e` call the same named recipes. Bare `pnpm ci`
is pnpm's dependency reinstall command. Nested dependencies dedupe, so run
only the highest tier needed. Build and integration recipes share output paths;
run one ladder invocation at a time in a checkout.

| Tier | Whole repository | Rust only | When |
| --- | --- | --- | --- |
| L1 | `just quick` | `just rust-quick` | After an edit batch |
| L2 | `just check` | `just rust-check` | Before claiming done / pre-commit |
| L3 | `just gate` | `just rust-gate` | Pre-PR |
| L4 | `just ci` | `just rust-ci` | Pre-merge / acceptance |
| L5 | `just e2e` | — | Real runtimes installed |

`just e2e` adds the proofs that need a real runtime or toolchain on the
machine: the WebAssembly guest matrix (Zig, Rust, JavaScript, Python, Go), an
actual Electron process, Bun consumers, workerd, a Next build, and the
native AI SDK WebSocket room consumer. They sit
above `ci` rather than inside it because a machine without those runtimes
cannot run them, and a suite that could not run must never be reported as one
that passed. In the guest matrix a missing toolchain prints `blocked` and the
summary names every row that did not run.

For focused tests and what each tier establishes, see
[`docs/guides/testing.md`](./docs/guides/testing.md). `pnpm test` uses in-process
transports; `just test-live` adds localhost sockets. Electron transport tests
inject fake Electron APIs and do not launch the desktop runtime — `just e2e`
is what actually starts one. Benchmarks are opt-in timings, outside the
quality ladder.

L3 includes `just test-cross-language`, a test-only Rust Todo process with
TypeScript callers. When changing that fixture or claiming native contract
parity, read `tests/typescript/cross-language/README.md` for its evidence limits.

L3 also includes `just release-test`: crash/recovery subprocesses and the installed
npm against a synthetic localhost registry with no production credentials. A
blocked loopback socket or missing npm is a blocked check, never a passed proof.
For manual publishing and partial-release recovery, read `scripts/release/README.md`.

MCP adapters serve protocol 2026-07-28 and reject legacy requests. The Rust
stdio wire proof is `just rust-mcp-modern-smoke`; its synthetic invoker proves
wire interoperability, not application execution. `serveHost().dispose()` is
awaited. The document workspace does not enable Cache Components, so Next 16.4.3 runs
unpatched; rerun its native action proof under `just e2e` after a Next change.

Use the Node version in `.node-version` and pnpm version in `package.json`.
CI installs the frozen pnpm graph and checks the whole Rust workspace at the
runtime minimum, with a separate pure-library MSRV job. Local Rust follows
`rust-toolchain.toml`. Report a failed prerequisite
or unavailable runtime as a blocked check, not a passed tier.

## Rust contract

Rust uses edition 2024. `boundary-core` and `boundary-macros` retain MSRV 1.88;
composition and binary crates use the higher runtime floor recorded in
`config/rust-crate-tiers.json`. Verify each tier at its declared minimum. Library code
forbids unsafe code, unwrap/expect, and panic. Keep public modules deep, types
validated at construction, and transports/frameworks out of `boundary-core`.
`just rust-gate` rejects common server/runtime dependencies and production Rust
source files over 500 lines.

## TypeScript contract

The SDK has one manifest at `packages/package.json`. Its `exports` point at
source for the workspace; tsdown (`packages/tsdown.config.ts`) builds
`packages/dist` and keeps `publishConfig.exports` pointing at the built files,
and `pnpm pack` applies `publishConfig`. `just build` stages the packed result
in `dist/boundary`. Publishing straight from `packages/` is refused; releases
are staged from verified candidates by `.github/workflows/release.yml`. Applications and proofs remain in
example and test roots. Source modules own capabilities; directory grouping
and optional SDK subpaths do not imply separate publication or maturity.

`package.json` exposes single-purpose leaves (`typecheck`, `test`,
`build:packages`, …) and aliases to composed just recipes. Keep recipe
dependencies in the justfile so package builds run once per invocation.
Production code imports the SDK subpath that owns each capability.

## Publishing

Before changing local consumer dependencies, package exports, or bundling, read
[`Use Boundary locally`](./docs/guides/local-consumers.md). External consumers
install a consumer-owned packed snapshot; reusable libraries peer and externalize
Boundary. Report the installed path, archive/content digests, source commit and
dirty state, and consumer checks separately. Use Boundary in code, proof names,
and workflow prose; `ops` remains only the checkout folder name.

Releases are staged by `.github/workflows/release.yml` through npm trusted
publishing and become installable only when a maintainer runs `npm stage approve`
with 2FA. Never add an npm token to CI, the repo, or a secret; never grant the
trust config direct publish or dist-tag rights; never run a real `npm publish`.
The workflow starts only from a manual dispatch, restores no caches, and gives
`id-token: write` to the stage job alone. Runbook: `scripts/release/README.md`.

## Native C ABI exception

`boundary-ffi` alone may use unsafe code for C ABI exports and pointer/length
conversion. Its safety contracts belong in the public header and each unsafe
operation. Core and other Rust libraries continue to forbid unsafe code.
