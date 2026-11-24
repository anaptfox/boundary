---
title: "Testing Boundary integrations"
description: "Which tests establish which facts across the quality ladder."
---

# Testing Boundary integrations

Test the host through its native dispatcher, then test the Host Module through
its public Interface. Test Handoff and Control separately at their own seams.

## Run the repository checks

Use the Node version in `.node-version`, the pnpm version in `package.json`,
and Rust with the components in `rust-toolchain.toml` (clippy and rustfmt on
the `stable` channel). `just install` installs the workspace dependencies; CI
uses `pnpm install --frozen-lockfile`. The pure Rust libraries support 1.88.0;
the composition libraries and CLI require 1.96.0 for Wasmtime 49. CI runs the
whole repository at the composition minimum and checks the pure tier separately
at 1.88.0.

The root justfile owns the cumulative ladder. The pnpm aliases use the same
names and run the same tier:

| Tier | Commands | Adds |
| --- | --- | --- |
| L1 | `just quick` / `pnpm run quick` | Documentation checks, TypeScript types, oxlint, Rust formatting and compilation |
| L2 | `just check` / `pnpm run check` | TypeScript tests (including SDK module dependency rules), TypeScript 500-line limit, the reviewed public API surface, Rust default features plus Control tests, public package builds |
| L3 | `just gate` / `pnpm run gate` | Release crash/recovery and synthetic npm loopback tests, packed consumer, native C ABI smoke, Hono/Worker/Durable Object/generated Next harnesses, Rust/TypeScript Todo process proof, modern MCP SDK/Rust stdio wire proof, strict Rust lint, feature matrix, architecture checks |
| L4 | `just ci` / `pnpm run ci` | Vite and Electron localhost transports, composition over TCP, warning-denied Rust docs, the pure core on both wasm targets, and re-derivation of the reviewed vectors and import-check fixtures |
| L5 | `just e2e` | The WebAssembly guest matrix (Zig, Rust, JavaScript, Python, Go); native Next, Worker, Durable Object, Vite, and Electron smokes; Bun packed consumers; the persistent-bot, native WebSocket room, and experimental packed Yjs/Automerge scene workflows; and the in-process Todo fixture |

`just api-surface` compares every exported name and declaration of the built
SDK with `tests/fixtures/api-surface.json`. A pure refactor leaves it unchanged;
an intended API change is reviewed in the diff and accepted with
`node scripts/check/api-surface.mjs --write`. Module rules, the API surface and
the package build's import checks parse source and output with oxc and resolve
specifiers with oxc-resolver, so type-only, re-export and `import()` forms are
all seen.

The inspector browser proof in L5 uses the workspace's pinned Playwright. Its
headless Chromium lives in Playwright's shared browser cache; when that exact
build is missing, the proof reports blocked and names `just browsers`, which
downloads it once.

L5 sits above `ci` rather than inside it because the native smokes, packed
Bun consumers, and persistent-bot workflow need real runtimes installed
on the machine. The in-process Todo fixture is included at this tier but does
not need those runtimes. A suite that could not run must never be reported as
one that passed. The guest matrix follows the same rule: a missing toolchain
prints `blocked` and the summary names every row that did not run.

`just native-abi-smoke` builds the native library and tests a staged, relocated
C and C++ consumer against its public header, shared library and static archive.
It requires native C/C++ compilers and supported linker tooling. Its C consumer
is built with ASan and UBSan; this does not mean the Rust library itself was
sanitizer-instrumented. See [Embed Boundary in a native host](./native-embedding.md)
for the host lifecycle and ABI limits.

Run the highest tier you need; its dependencies include the lower tiers once.
Keep one build or ladder invocation active per checkout because package builds
write shared output directories.
Use `pnpm run ci` for the quality ladder: bare `pnpm ci` is pnpm's dependency
reinstall command.

`just rust-quick` also checks the Reach client as a production library in a
separate Cargo invocation, so test-only dependency features cannot mask its
compile failures. Run `just rust-reach-client-compile` for that check alone.

For a focused check:

```console
pnpm test tests/typescript/thumbnail-docs.test.ts
pnpm typecheck
just rust-check
just pack-smoke
just framework-smoke
just test-live
```

`pnpm test` uses `config/vitest.config.ts`. It runs
`tests/typescript/**/*.test.ts` and `*.test.tsx`, excluding `tests/typescript/live/` and `tests/typescript/cross-language/`.
Composition tests use injected fetch in this suite. The unit suite also covers
injected Electron protocol, IPC, and window APIs; those fakes do not establish
behavior in a launched Electron desktop app.
TypeScript also checks the `*.types.ts` assertions, all documentation examples,
and Vitest configurations; those type assertions are not runtime tests.
Tests that spawn a real build or runtime live in `tests/process/` and are
invoked by just recipes, not by `pnpm test`. `tests/fixtures/` holds inputs
those tests consume.

`pnpm test:transports` uses `config/vitest.live.config.ts` for real loopback
sockets. It adds the Electron HTTP and Todo MCP tests, observation delivery,
the bus client, the native AI SDK WebSocket consumer, Control capability checks over TCP, and repeats composition
assertions over TCP.
`just test-live` also builds the packages and runs the Vite localhost harness.

The package, framework, and live pnpm workflows delegate to just so their
required builds happen automatically. Process tests under `tests/process/`
consume those built artifacts. Benchmarks (`just bench`, `just bench-compare`)
remain opt-in and outside the quality ladder.

For a retained library comparison, run the same workload in fresh processes:

```console
node scripts/perf/run.mjs --rounds 3 --label before-change
# Make the production change, keeping the benchmark harness unchanged.
node scripts/perf/run.mjs --rounds 3 --label after-change
just bench-compare .private/perf/before-change.json .private/perf/after-change.json
node --test tests/scripts/perf-lib.test.mjs
```

Labels preserve immutable aggregate reports and per-process reports under
`.private/perf/`; an existing `baseline.json` is preserved. Reports retain raw
chronological samples, source and harness fingerprints, runtime versions,
machine metadata, and process-median ranges. The comparator rejects different
harnesses, workloads, machines, or runtime settings. Ranges describe observed
variation, not confidence intervals. Cheap synchronous cases time batches;
their normalized p95 describes batch means. HTTP cases use in-process
Request/Response handling, and React cases use happy-dom; these timings do not
establish socket throughput or browser responsiveness. `--ts-only` selects a
separate comparison mode.

For a Vitest CPU profile, put Node's profiling flags on its command line so
Vitest forwards them to its forked workers:

```console
mkdir -p .private/perf/profiles
node --cpu-prof --cpu-prof-dir=.private/perf/profiles node_modules/vitest/vitest.mjs run --config config/vitest.perf.config.ts tests/typescript/perf/handoff-scaling.bench.ts
```

Retain the worker profiles containing Boundary frames as well as the command
and source identity. A coordinator profile alone cannot explain library cost.
Keep profiling separate from the timed comparison runs.

`just bench-guests before 2` times two complete language-matrix runs and writes
per-row logs, test counts, artifact digests, and timings under
`.private/perf/guests/`. It retains existing compiler caches: row wall time
includes component builds and Cargo, while the separate test time is reported
by Rust's harness. Compare the same machines, toolchains, assertions, and build
profiles; report one-time native compilation separately from repeated runs.

JavaScript, Python, and Go component builds reuse an artifact only when source
contents, the build recipe, tool identity, and its output digest match. Cache
hits still validate the component and run every E2E test. Use
`BOUNDARY_GUEST_REBUILD=1 just wasm-guest-smoke` to force those component builds.
Zig and Rust retain their toolchains' own incremental build behavior.

The test profile optimizes external Rust dependencies while keeping workspace
code debuggable. Plugin tests enable Wasmtime's parallel compilation feature;
production hosts still choose their engine configuration. Zig, Rust, and Go
E2E tests share immutable compiled components within each test process, while
stores, host bindings, fuel budgets, and guest heaps remain separate.

`just test-cross-language` builds a test-only native Rust Todo host and runs
TypeScript callers over framed stdio. It checks the shared seven-interaction
scenario, generated input/output references, rejection before effects, and
caller-side Control recovery after discarding a completed mutation's response.
It runs at L3; an unavailable Cargo toolchain or binary fails the recipe rather
than silently skipping the proof. See the [fixture evidence and remaining
declared-error gap](../../tests/typescript/cross-language/README.md). This is
experimental test infrastructure, not a published client generator or a claim
of complete native contract parity.

CI runs the PR gate or main acceptance at the composition Rust minimum.
`just rust-msrv` repeats all-feature tests and strict lint for the published
pure tier (`boundary-core` and `boundary-macros`) at Rust 1.88.0. Composition
crates declare a higher floor; see `config/rust-crate-tiers.json`. Local
default Rust otherwise follows `rust-toolchain.toml`.

`just wasm-tools-status` compares installed component tools with
`config/wasm-versions.json`; `just wasm-tools-install` installs missing tools
and updates mismatched Cargo tools. Python's componentizer is installed with
`uv tool install`; the JavaScript tool comes from the workspace dependency.
Use `node scripts/check/wasm-toolchain.mjs --strict` to require matching versions.
Guest builds and execution remain separate evidence from tool availability.

## Ownership, recovery, and observation regressions

The unit suite includes mutable-input and accessor attacks against cached
validation, compiled-schema equivalence, candidate Projection assessment,
shared Handoff response laws, and React/headless lifecycle regressions.

`control-journal-laws.test.ts` runs the same journal laws against memory and
SQLite. `control-durable-crash.test.ts` kills a child process at committed
attempt, effect, and receipt boundaries, reopens the database, and checks
recovery without duplicate application. It also checks fencing between two
connections. This proves the exercised process-crash behavior, not power-loss
or distributed-database durability. TypeScript and Rust independently consume
the reviewed portable recovery traces in `tests/conformance/v1/`.

The live suite includes `observation-delivery.test.ts`: a separate host process
publishes authenticated, tenant-filtered observations to a mounted read. It
checks completed and uncertain writes, reconnect refresh after a delivery gap,
installation isolation, and disposal without retrying a change. In-process
stream tests separately cover malformed frames and idle-reader cancellation.

## Native experience and portable-runtime checks

The opt-in `just framework-native-smoke` recipe runs the native application
fixtures with one shared package build. Individual recipes are
`next-native-smoke`, `worker-native-smoke`, `durable-object-native-smoke`,
`vite-native-smoke`, and `electron-native-smoke`. They require local sockets
and the relevant installed runtime. The Next fixture uses the default
production bundler; the Electron fixture must launch the actual desktop
process. A missing runtime, denied launch, or failed prerequisite blocks its
proof; fake APIs do not substitute for that run.

`just framework-demo-smoke` adds the bounded persisted demo workflow group:
the Next production proof includes document/MCP/publication review and the
triage/studio human forms; `persistent-bot-smoke` launches Bun subprocesses to
exercise crash-after-effect, restart, and observation-only reconciliation.
`next-publication.test.ts` separately proves exact approval and process-death
recovery against a temporary SQLite journal. Model quality and production
authentication remain outside deterministic acceptance.

`just portable-smoke` checks the packed portable consumer on Node and Bun.
This is an explicit runtime matrix, not a switch to Bun for repository
tooling and not a claim that native framework entry points run everywhere.
The packed consumer also checks a browser client/store/React bundle for
server-only code; a bundle check does not establish browser interaction.

`just crdt-e2e` separately proves optional engine isolation and both native
adapter subpaths from an isolated packed consumer. Each engine uses two real
replicas and native update/Sync exchange over a private loopback TCP relay
within the same consumer process. The shared host example proves admission and
revocation, capture immutability after live edits and deletion, acceptance
baseline races, content-digest validation, and encode/reload. The relay has no
authenticated principal, so the proof does not establish authorization of raw
inbound CRDT traffic, cross-process collaboration, browser behavior,
cross-engine parity, or crash/power-loss durability. `just e2e` includes this
focused L5 proof after the shared package build.

These native and portable-runtime checks run at L5. They are not silent
requirements for L1–L4. Availability of a recipe is not a passing result, and
passing this matrix alone does not complete the four persisted demonstration
workflows. See the [current status](../concepts/current-status.md)
for the supported boundaries. TypeScript checks the native example sources
alongside the other library and documentation examples.

## Definition and compilation tests

Assert that:

- explicit interaction IDs are preserved byte-for-byte;
- route, tool, implementation, and mount changes preserve contract identity;
- schemas, declared errors, arity, reads, and changes affect identity;
- shared `contract-compatibility.json` vectors prove directional schema,
  footprint, and declared-error judgments;
- documentation annotations and implementation functions do not;
- duplicate IDs and unsupported schema meanings reject;
- repeated compilation of the same validated in-memory record produces the
  same Program and handles;
- CompiledInteractions contain no handlers, stores, actors, credentials, policy,
  or ambient context.

## Projection tests

Construct Projections without an Installation. Assert that:

- only explicit handles and nonempty `direct` or `request` modes are accepted;
- aliases and modes participate in Projection identity;
- unselected Program interactions do not affect Projection identity;
- projected handles expose only selected interactions and typed modes;
- a Projection remains valid with zero realizations;
- no group, tag, predicate, registry, or discovery mechanism widens selection.

## Implementation and Installation tests

For bare TypeScript, prove `implementInteractions` rejects missing and extra
members and preserves input, output, context, and declared-error correlation.

For every Installation, assert that:

- availability and Catalog derive only from exact installed entries;
- each installed interaction-mode has one realization;
- unrelated compiled interactions are unavailable unless explicitly installed;
- routing, replicas, and failover stay inside the host dispatcher;
- invalid native output or declared-error payload becomes
  `invalid-realization-outcome` with certainty `unknown`;
- host-controller revocation makes future calls fail before execution while
  execution values expose no revoke method;
- revocation during an in-flight dispatch preserves honest certainty.

Also prove a direct-only installation graph contains no Control package.

## Atomic Binding tests

Exercise both branches of `bindProjection`:

- all entries compatible and available yields one Binding;
- any missing interaction, incompatible contract or arity, or missing direct or
  request mode yields one exhaustive `unrealized` report;
- request identity is an actual Installation fact pinned by a successful
  Binding, not a desired Projection constraint; binding the same Projection to
  a different request realization produces a different Binding;
- no partial Binding or Caller is returned;
- one Projection can bind to separate Installations, producing separate pinned
  Bindings;
- an existing Binding never follows replacement;
- Installation extras never widen the projected surface;
- the Binding manifest exposes only selected expected and actual identities,
  modes, request preview contracts, live Installation identity, and digest;
- it exposes no admission function, context, handler, or unselected inventory.

## Caller and admission tests

Use a recording native dispatcher behind a real Installation. For a successful
call, assert that admission and dispatch receive:

- the same context object supplied as the final Caller argument;
- the selected projected handle and pinned actual interaction;
- the same normalized validated input;
- the selected mode.

Prove invalid input and admission denial stop before dispatch. A broken
admission Adapter is a fault, not denial. TypeScript declared errors must be
narrowed through `isDeclaredInteractionError` with the projected handle; arbitrary
host exceptions remain sanitized.

Test contextful and contextless arities without requiring `undefined`, `{}`, or
a global context singleton.

## Remote Handoff tests

Keep hostile serialized values out of ordinary Caller tests. At the Handoff
seam, test:

- unsupported intent and outcome versions;
- stale Binding identity and live Installation replacement;
- tampered expected-to-actual pins;
- unselected interaction and wrong mode;
- invalid or nonportable input;
- extra, accessor, hidden, and malformed reference properties;
- preservation of denial owner and `not-started`, `not-completed`, or `unknown`
  certainty in the serialized outcome.

Transports should be tested only for framing, handshake delivery, explicit
configuration, and faithful Handoff outcome mapping. They must not duplicate
validation or conservation logic.

## Adapter tests

Build documentation Adapters from a Projection and serving Adapters from a
Binding or Binding manifest. Test explicit HTTP paths, MCP server name/version,
framework mounts, Electron ports/schemes/partitions/channels, Cloudflare
bindings, and WebMCP ports.

Prove a serving Adapter cannot widen selection, access native dispatch, or
infer admission from visibility.

## Control tests

The `@foxworth/boundary/testing` subpath provides deterministic
`MemoryJournal`, `TestClock`, and `TestIds`; the memory journal is not durable
production storage.

Test at least:

- request contribution can only plan and create a proposal;
- request validates and admits before planning and never executes;
- public proposals exclude private state and raw input;
- request, approval, grant, and attempt remain separate authority phases;
- context reaches hooks by exact reference and is never persisted;
- durable records pin full Installation identity;
- completion requires output validation, verification, and a durable receipt;
- replay returns the original receipt without another apply;
- every post-attempt ambiguous failure remains `uncertain`;
- reconciliation returns `completed`, `not-applied`, or `uncertain` without
  rerunning apply;
- expired leases are fenced before reconciliation.

## Build workflow tests

For the current `@foxworth/boundary/build` Adapter, prove:

- exactly one explicit module entry is loaded;
- only its named plain `interactions` record is accepted;
- factories, promises, scanners, globs, registries, and custom interpreters are
  rejected;
- module evaluation is not claimed to be hermetic;
- compilation and artifact rendering are deterministic after loading;
- rendering is pure and returns immutable relative paths plus exact bytes;
- typed references contain only structural runtime data and continue to work
  across separately installed package module instances;
- emitted reference source is compiled and imported as JavaScript, while a
  typed consumer proves selected mode and arity constraints;
- generated request references retain their explicitly supplied public result
  type and emit no runtime import;
- writing requires one explicit destination;
- stale deletion removes only files recorded in the writer's versioned
  inventory, never unmanaged files, and never follows a symbolic-link parent;
- build code cannot fabricate Installation or Binding manifests.

`just framework-smoke` builds or runs real Hono, Next, Cloudflare Worker, and
Durable Object harnesses. `just test-live` exercises the Vite localhost mount
and Electron HTTP/protocol/IPC doors. These are integration evidence beyond
the focused adapter tests; neither substitutes for a downstream product build.

Current Host lifecycle, foundation, adapter, and shared-conformance tests are
the repository evidence for these boundaries. Downstream products still need
their own dispatcher, storage, authorization, recovery, and release proofs.

The packed inspector browser proof runs as part of `just e2e`. It uses the
repository's pinned Playwright; run `just browsers` once to install its Chromium. It installs an isolated packed
consumer and requires localhost sockets; missing prerequisites are reported as
blocked, not a passing proof. Run `just inspector-browser-e2e` for this proof alone.
