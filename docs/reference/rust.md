---
title: "Rust lifecycle and conformance"
description: "The independent native Rust implementation and the evidence it shares with TypeScript."
---

# Rust lifecycle and conformance

TypeScript leads the Boundary release. The Rust workspace is an independent native
implementation used to test whether shared laws survive outside the TypeScript
interface. It does not embed TypeScript, and TypeScript does not load the Rust
crates. The crates are unpublished (`publish = false`) until a separate release
decision and acceptance gate.

## Crates

| Crate | Job | Tier | Min Rust | TypeScript counterpart |
| --- | --- | --- | --- | --- |
| [`boundary-core`](../../crates/boundary-core/README.md) | Interactions, Program contracts, Surface, Installation, Binding, Handoff, Control, observations | pure | 1.88 | `@foxworth/boundary`, `/program`, `/handoff`, `/control`, `/observations`, `/drafts` |
| [`boundary-macros`](../../crates/boundary-macros/README.md) | `#[derive(Interaction)]` and `#[derive(Fault)]`, behind the `derive` feature of `boundary-core` | pure | 1.88 | `defineInteraction` from `@foxworth/boundary` |
| [`boundary-cli`](../../crates/boundary-cli/README.md) | The `boundary` command: local bus and interaction discovery | binary | 1.96 | none (`/bus` and `/mcp` are the library counterparts) |
| [`boundary-ffi`](../../crates/boundary-ffi/README.md) | Synchronous C ABI over the checked lifecycle | composition | 1.96 | none (Rust and C only) |
| [`boundary-bus`](../../crates/boundary-bus/README.md) | Per-user local bus that resolves Reach records | composition | 1.96 | `@foxworth/boundary/bus` |
| [`boundary-reach`](../../crates/boundary-reach/README.md) | Reach records, HTTP framing, and the blocking client (`client` feature) | composition | 1.96 | `@foxworth/boundary/reach`, `/http/protocol` |
| [`boundary-mcp`](../../crates/boundary-mcp/README.md) | Model Context Protocol server over reachable interactions | composition | 1.96 | `@foxworth/boundary/mcp` |
| [`boundary-plugin`](../../crates/boundary-plugin/README.md) | WASM guest realizations run by wasmtime | composition | 1.96 | `@foxworth/boundary/plugin` |

The tiers and minimum versions come from
[`config/rust-crate-tiers.json`](../../config/rust-crate-tiers.json). Pure crates
must not depend on runtimes, transports, or frameworks. Composition crates may
depend on the pure tier, and the binary crate only wires composition crates
together. The two example crates are executable proofs with no MSRV promise.

## Start here

Depend on a crate by path from a checkout. Crates are not on crates.io. A git
source (`git = "https://github.com/anaptfox/boundary"`) follows the same Cargo
form but is not exercised by this repository's checks. Enable `derive` for the
`#[derive(Interaction)]` and `#[derive(Fault)]` macros:

```toml
[dependencies]
boundary-core = { path = "/path/to/boundary/crates/boundary-core", features = ["derive"] }
```

Run the native Todo host from the repository root:

```sh
cargo run -p boundary-todo-example
```

Its [README](../../examples/concepts/rust/todo/README.md) walks through the code.

## Where things live

Public paths are what a Rust host imports. Source paths are under
`crates/boundary-core/src/` unless a row says otherwise.

| Capability | Public path | Source |
| --- | --- | --- |
| Interaction, footprints, `Handler` | `boundary_core::{Interaction, Handler, ReadOnly, ChangesState}` | `interaction.rs` |
| Wire codecs, portable faults | `boundary_core::{WireCodec, JsonCodec, PortableFault, NoError}` | `codec.rs` |
| Program, contracts, digests, changes | `boundary_core::{Program, InteractionContract, ContractDigest, contract_changes, contract_compatibility}` | `program.rs`, `program/` |
| Draft (inert proposal) | `boundary_core::Draft`, `boundary_core::lifecycle::{propose, accept, reject}` | `program/draft.rs`, `lifecycle/drafts.rs` |
| Compiled interaction | `boundary_core::lifecycle::{compile_interaction, CompiledInteraction}` | `lifecycle/compiled.rs` |
| Surface | `boundary_core::lifecycle::{project, select, Projection, ProjectionHandle}` | `lifecycle/projection.rs` |
| Installation and realizations | `boundary_core::lifecycle::{install, direct_realization, request_realization, dispatch_realization, declared_interaction, observed_read_realization, RealizationId, InstallationId}` | `lifecycle/installation.rs`, `installation/adapter.rs`, `installation/observed.rs`, `installation/native.rs` |
| Binding and Caller | `boundary_core::lifecycle::{bind, BindResult, Binding, Caller, CallerError, AdmitAll, admit_all, restrict_binding, coordinate_binding}` | `lifecycle/binding.rs`, `lifecycle/binding/` |
| Presentation | `boundary_core::lifecycle::present_projection` | `lifecycle/presentation.rs` |
| Invocation observation | `boundary_core::lifecycle::InvocationObservation` | `lifecycle/observation.rs` |
| Handoff | `boundary_core::handoff::{checked_handoff, CheckedHandoff, HandoffTransport, RemoteCaller, HandoffInvocation, HandoffOutcome}` | `handoff.rs`, `handoff/` |
| Control | `boundary_core::control::{ControlledHandler, ControlledEffect}` | `control/` |
| Observed reads | `boundary_core::observations::{SnapshotSource, ObservationSnapshot, ReadEvaluator, ObservedReadOptions, ReadReuse}` | `observations/` |
| Execution evidence | `boundary_core::evidence` | `evidence.rs` |
| Reach records | `boundary_reach::{ReachRecord, Transport}` | `crates/boundary-reach/src/record.rs` |
| HTTP framing and client | `boundary_reach::{resolve, status_for_result}`; `fetch_manifest` and `invoke` need the `client` feature on Unix | `crates/boundary-reach/src/framing.rs`, `client/` |
| Local bus | `boundary_bus::{BusServer, BusClient}` | `crates/boundary-bus/src/socket.rs` |
| MCP server | `boundary_mcp::{serve, tools_from_manifest, merge}` | `crates/boundary-mcp/src/` |
| WASM plugins | `boundary_plugin::{PluginComponent, HostImports, HostFunctions, project_wit}` | `crates/boundary-plugin/src/` |

## Shared evidence

Each vector in [`tests/conformance/v1/`](../../tests/conformance/v1/README.md)
is read by both the Rust and the TypeScript suites. A parity claim holds only
for the laws in that vector's README. The table names the tests that read each
vector.

| Vector | Laws it backs | Rust test | TypeScript test |
| --- | --- | --- | --- |
| `program.json` | canonical JSON, contract and Program identity | `boundary-core/tests/program_conformance.rs` | `tests/typescript/cross-language-conformance.test.ts` |
| `contract-compatibility.json` | directional `contractCompatibility` | `boundary-core/tests/program_compatibility.rs` | `tests/typescript/program-compatibility.test.ts` |
| `host-lifecycle.json` | Surface, atomic Binding, pinned manifest, four certainties | `boundary-core/tests/host_lifecycle_conformance.rs` | `tests/typescript/host-lifecycle-conformance.test.ts` |
| `composition.json` | empty surfaces, observation envelope, presentation digest | `boundary-core/tests/composition.rs` | `tests/typescript/model-composition.test.ts` |
| `binding-restriction.json` | subset selection, admission order, revocation lineage | `boundary-core/tests/binding_restriction.rs` | `tests/typescript/binding-restriction.test.ts` |
| `invocation-coordination.json` | invocation coordination | `boundary-core/tests/binding_coordination.rs` | `tests/typescript/native-dispatch.test.ts` |
| `observed-reads.json` | point and query evidence validation | `boundary-core/tests/observed_reads.rs` | `tests/typescript/observed-reads.test.ts` |
| `handoff-response.json` | seven response identity fields | `boundary-core/tests/handoff_v1.rs` | `tests/typescript/handoff-response-laws.test.ts` |
| `draft.json` | Draft proposal identity | `boundary-core/tests/draft_conformance.rs` | `tests/typescript/program-draft.test.ts` |
| `execution-evidence.json` | causal evidence envelope | `boundary-core/tests/execution_evidence.rs` | `tests/typescript/execution-evidence.test.ts` |
| `nullable-authoring.json` | normalized nullable schema values | `boundary-core/tests/nullable_authoring.rs` | `tests/typescript/nullable-authoring-conformance.test.ts` |
| `control-recovery.json` | Control recovery traces: apply suppression | `boundary-core/tests/control_lifecycle.rs` | `tests/typescript/control-durable-crash.test.ts` |
| `reach.json` | Reach record shape | `boundary-reach/tests/reach_conformance.rs` | `tests/typescript/reach-record.test.ts` |
| `http-framing.json` | HTTP framing of Handoff | `boundary-reach/tests/http_framing_conformance.rs` | `tests/typescript/http-framing-conformance.test.ts` |
| `mcp-envelope.json` | model-facing tool result envelope | `boundary-mcp/tests/envelope_conformance.rs` | `tests/typescript/mcp-envelope-conformance.test.ts` |
| `wasm-projection.json` | WIT surface of a Program | `boundary-plugin/tests/wasm_projection_conformance.rs` | `tests/typescript/plugin-wit.test.ts` |
| `wasm-import-subset.json` | bind-time guest import refusal | `boundary-plugin/tests/wasm_import_subset.rs` | `tests/typescript/wasm-import-subset.test.ts` |

Paths under `boundary-core/`, `boundary-reach/`, and `boundary-plugin/` are
relative to `crates/`.

Control is Rust-only except for recovery traces. `control-recovery.json` covers
apply suppression on recovery, and both suites read it. Proposals, approvals,
grants, attempts, and receipts have no shared vector; the Rust checks for them
live in `boundary-core/tests/control_lifecycle.rs`. The vectors do not establish publication, full feature
parity, semantic equivalence, policy quality, or production readiness.

## Checks

| Command | Adds |
| --- | --- |
| `just rust-quick` | format check and `cargo check` over every target |
| `just rust-check` | the default-feature test suite |
| `just rust-gate` | strict clippy, all-feature and no-default-feature tests, and the tier rules (`scripts/check/rust-architecture.mjs`) |
| `just rust-ci` | warning-denied `cargo doc` |
| `just gate` | `rust-gate`, plus `rust-mcp-modern-smoke`, `native-abi-smoke`, and `test-cross-language` |
| `just ci` | `rust-ci`, plus the rest of the repository ladder |
| `just bus-test` | `boundary-bus` and `boundary-reach` tests |
| `just rust-msrv` | opt-in Rust 1.88 check for `boundary-core` and `boundary-macros` |

Report a missing toolchain or runtime as a blocked check, not a passed one.

## C ABI

`boundary-ffi` exposes the checked native lifecycle as a C ABI. It is the only
crate that may use `unsafe`, for export and pointer conversion. The public
header is the hand-written
[`crates/boundary-ffi/include/boundary.h`](../../crates/boundary-ffi/include/boundary.h).
`just native-abi-smoke` checks that every exported `boundary_*` symbol is
declared in it, and that every declaration is exported. ABI version 1 reports
capability bits for direct (1) and request (2) modes.

- [Embed Boundary in a native host](../guides/native-embedding.md) covers
  building, linking, and callback ownership.
- [`examples/concepts/c`](../../examples/concepts/c/README.md) holds the C and
  C++ consumers the proof builds.

## Native authoring

Rust keeps ordinary request structs and derives their inert contracts:

```rust
#[derive(Serialize, Deserialize, JsonSchema, Interaction)]
#[interaction(
    id = "todos.complete",
    output = Todo,
    error = TodoError,
    reads("todos"),
    changes("todos")
)]
#[serde(deny_unknown_fields)]
struct CompleteTodo {
    id: TodoId,
}
```

`compile_interaction::<O>()` returns a handler-free `CompiledInteraction<O>` with
the portable descriptor, input arity, and exact contract identity. The compiled
interaction has no call method. Surface and Installation assembly derive their
closed Programs from these compiled interactions, so authors do not maintain a
second registry by hand.

The underlying `Interaction`, `Handler`, and codec traits remain public for native
authoring. The crate stays executor-neutral and does not require Tokio,
async-std, or `async_trait`.

## Realizations and Installation

`direct_realization` adapts one `Handler<O, Context>` into one direct
Installation contribution. When the expected and installed contract identities
and native Rust interaction types are exact, typed in-process calls retain the
native interaction, output, and declared-error types through dispatch without
encoding or decoding through `WireCodec`. The internal type erasure is private
to the Installation module.

A structurally compatible but nonidentical installed contract remains a real
callable Binding rather than a metadata-only claim. That call crosses a private
codec bridge: expected input is encoded, decoded as the installed native type,
executed once, then the actual output or declared error is encoded and decoded
as the expected native type. The same bridge protects distinct native Rust types
that compile to one identical portable contract. A codec failure before handler
entry is invalid input; a failure after execution is `Unknown`.

`dispatch_realization` is the explicit dynamic seam for an existing host-native
dispatcher. Its `NativeDispatchOutcome` preserves returned values, declared
errors, and pre-effect host denial. Its `NativeDispatchFault` is explicit:
`NotStarted`, `NotCompleted`, or `Unknown`. That path normalizes portable input
and validates portable returned or declared-error data against the compiled
codecs. Invalid boundary data is an `Unknown` fault rather than evidence that
execution did not start. Binding admits and dispatches once; a dispatcher must
not retry an effect that may already have started.

`install` atomically assembles immutable contributions under one host-issued
`InstallationId` and one exact `RealizationId` per `(interactionId, mode)`. Its
`Installed` result contains the execution-only Installation and a separate
host-held controller. `declared_interaction` retains a known contract with no
current mode; Binding can then report exact `missing-direct` or
`missing-request` rather than pretending the interaction is absent. Missing
interactions or modes are not filled with optional handlers or a mutable global
registry.

Request-mode contributions use `RequestCapability` from
`boundary_core::lifecycle`. Version 1 Handoff lives in `boundary_core::handoff`. The
standalone Control model is `boundary_core::control`. It is always compiled, is
not on the crate root, and the lifecycle module neither installs it nor grants it
authority. A request realization creates public request data; it does not apply
the interaction.

## Durable Surface and atomic Binding

`project` constructs a serializable, data-only Surface from explicit
`select(alias, compiled_interaction, modes)` values. Surface creation does not
inspect an Installation, so desired caller surfaces may remain unrealized and
be realized later. Typed handles are recovered with
`projection.handles().get(alias, &compiled_interaction)` and carry the exact
Surface and contract identity.

`bind` checks one complete Surface against one exact Installation and
returns `BindResult::Bound` with an execution-only Binding plus controller, or
an exhaustive `BindResult::Unrealized` report.
Expected-to-actual contracts are checked directionally. The resulting manifest
pins the Surface's expected selected Program and the Installation's actual
selected Program independently. It never exposes a partial Caller and never
follows a replacement Installation.

Only the host-held controller can revoke the live Binding; code receiving the
Binding cannot. Its serializable version 1 manifest pins the
Surface, Installation, expected and actual contract identities, modes,
arities, and Realization IDs without containing handlers, invocation context,
admission policy, liveness, or revocation authority.

### Explaining a contract change

A changed contract digest says that a declaration moved, not where.
`contract_changes(&before, &after)` returns a `ContractDelta`. Its `changes`
list holds added, removed, or changed elements with old and new JSON values when
present. Dotted paths such as `outputSchema.properties.reply_url` are display
labels, not addresses or patch instructions; literal periods in property names
can make them ambiguous. Arrays are reported as whole values, and footprints
are normalized before comparison. Its `existing_callers` field is
`contract_compatibility(before, after)`: whether a Binding would still accept a
caller built for `before` against a realization of `after`.

TypeScript exposes its native equivalent as `contractChanges` from
`@foxworth/boundary/program`. These are review aids for whoever accepts the
change. They describe declarations only and prove nothing about behavior. There
is no wire schema, identity, or shared portable output guarantee for the report;
the compatibility laws remain covered by shared conformance evidence. The host
owns acceptance and execution, and Binding performs its compatibility check.

## Caller, context, and errors

`binding.caller()` returns a stateless Caller. Each invocation supplies its
context rather than storing it:

```rust
let output = binding
    .caller()
    .call(&context, &complete_handle, CompleteTodo { id })
    .await?;
```

The same borrowed context reaches admission and the selected realization. A
contextless host passes `&()`. Exact native direct admission can inspect the
interaction with `AdmissionRequest::native_input`; compatible direct calls,
dynamic dispatch, and request admission receive normalized portable input
through `portable_input`.

Rust declared errors remain ordinary typed values. `Caller::call` returns
`Result<Output, CallerError<DomainError>>` and distinguishes
`CallerError::Declared(error)` from denial, revocation, invalid input, wrong
Surface, and an `Unknown` execution fault. Each failure also reports a
portable certainty and result category.

Every `Interaction::Error` implements `PortableFault`. The `Fault` derive is the
normal authoring path: each variant declares one stable, definition-owned code.
That code, rather than `Display` or `Debug` text, is the public error vocabulary
at a Handoff boundary. An enum marked `#[serde(tag = "code", content = "details")]`
is the `{ code, details }` error envelope itself and declares exactly the
`errorSchema` TypeScript builds from `errors`; see the
[`boundary-macros` README](../../crates/boundary-macros/README.md). `NoError` remains the uninhabited choice for interactions
without declared failures.

## Portable seams

`WireCodec<T>` separates a native Rust type from its portable representation.
Serde and Schemars provide the default convenience codec; a manual codec may
lower a richer domain type through a distinct wire DTO. Codecs establish
contracts at compilation and protect request, dynamic-dispatch, and structural
compatibility seams without turning exact same-type direct calls into JSON round
trips.

The portable contract and Program domains remain
`boundary.interaction-contract/v1` and `boundary.program/v1`. Rust serializes and validates
Surface, Installation, and version 1 Binding artifacts.

Rust exposes the complete transport-neutral version 1 Handoff boundary from
`boundary_core::handoff`:

- `checked_handoff(&binding)` creates a server boundary over one exact live
  Binding. `invoke(invocation, &context)` validates every Binding,
  Installation, interaction, expected-contract, actual-contract, mode, and
  Realization pin before admission. Portable input must satisfy both pinned
  contracts before the realization can run.
- `HandoffTransport` carries an owned `HandoffInvocation` to an untrusted
  `HandoffOutcome`; it owns no selection, policy, retry, context, or execution
  authority.
- `RemoteCaller::new(manifest, transport)` pins one validated Binding manifest.
  Its typed `call` and `request` methods encode through the interaction codecs,
  reject response pin drift, validate returned values against both pinned
  contracts, and reconstruct the exact typed output or declared error.

Declared errors cross as their `PortableFault` code plus their validated codec
representation. Realization failures and transport failures expose no native
message, stack, or private field. A transport failure and any malformed or
untrusted outcome have `unknown` certainty; the remote caller never retries or
rebinds automatically. Boundary supplies no framework-specific Rust transport
adapter. A host implements `HandoffTransport` and resolves request-native
context at its own boundary.

The reviewed vectors listed under [Shared evidence](#shared-evidence) cover
contract identity, directional compatibility, Installation and Binding
pins, the four invocation certainties, and the seven Handoff response identity
fields (`handoff-response.json`). Neither runtime calls the other. A parity claim
exists only where both independent suites assert the same vector field.

## Composition and observations

`project(Vec::new())` yields an authentic empty surface which can bind and
handshake without exposing an interaction. `lifecycle::present_projection` accepts
a Surface and a `BTreeMap<String, InteractionPresentationOverride>`. It produces
the same presentation identity and schema-derived facts as TypeScript
(`composition.json`); only title and description may be overridden.

`lifecycle::InvocationObservation` validates the portable evidence envelope when
deserialized. `CheckedHandoff::invoke_observed(invocation, context, correlation,
publish)` invokes once and awaits a host-supplied publisher returning a Result.
Delivery errors do not reclassify execution. Correlation is explicit portable
JSON; input, output, and context are excluded. Hosts remain responsible for
publisher timeouts and panic policy. Native typed callers can use the validated
observation artifact in their own host integration; the checked Handoff method
provides the built-in observation hook.

Offline references and `realizationIdsFor` are TypeScript authoring helpers.
Rust keeps native typed handles and explicitly host-issued `RealizationId`s.
Changing executable behavior requires fresh host identity in both implementations.

## Native observed reads

`lifecycle::observed_read_realization` contributes a read-only native realization
with an optional installation-local retained-result cache:

```rust
let contribution = observed_read_realization(
    &compiled_read,
    RealizationId::new("host/documents/read-v2")?,
    document_snapshots,
    document_evaluator,
    ObservedReadOptions {
        reuse: ReadReuse::Validated,
        ..Default::default()
    },
);
```

The host implements `observations::SnapshotSource<Context>` to keep one immutable
snapshot or transaction through a callback. Its `ObservationSnapshot` implements
point reads, queries, and evidence validation. `ReadEvaluator` supplies fresh
authorization, an exact owned visibility scope, synchronous evaluation through
`ObservationView`, and native output validation. The usual typed Caller remains
unchanged. `ReadOnly` is a type constraint, so changing interactions cannot use
this constructor.

Point evidence distinguishes absence from a present native null-like value.
Query descriptors include the filter, ordering, and pagination; query tokens must
cover the complete resulting membership, order, and values, including insertions
that shift a page. A `Matching` token permits reuse within the same snapshot
callback. Changed, unavailable, or failed validation causes fresh evaluation.
Errors, incomplete views, and rejected outputs are never retained. The
evaluator may handle a captured read error and return a valid domain fallback;
that invocation still cannot retain its incomplete evidence. The complete
snapshot boundary must return successfully before any new result is retained;
an adapter failure after evaluation cannot populate the cache. Reuse defaults
off, with a 128-entry FIFO bound when enabled; zero entries disables retention.

The cache belongs to the consumed contribution's exact compiled contract,
realization, and installation allocation. Exact input and visibility equality
is checked within that allocation. Installation revocation clears and closes
the cache. Native keys, queries, scopes, tokens, and outputs stay native; exact
typed calls do not require JSON encoding or decoding. Native equality must cover
immutable identity, and `Clone` must produce independently owned retained and
returned values. Sharing mutable application state through these values violates
the snapshot adapter's contract.

Evidence completeness and evaluator purity remain host responsibilities. The
library cannot detect a dishonest validator or untracked ambient I/O. The shared
observation fixtures and native generated comparisons check the supplied adapter
against fresh evaluation, including deliberately incomplete negative controls.
Optional `ReadDiagnostic` counters stay private to the host; diagnostic failures
do not change invocation results or portable observation envelopes.

The native MCP wire adapter serves protocol **2026-07-28** over stdio, using
`server/discover` and per-request envelopes. Legacy initialization is rejected.
The native SDK consumer proof is `just rust-mcp-modern-smoke`; its synthetic
invoker establishes wire interoperability and retained unknown outcomes, not
real application execution or the TypeScript SDK's full capability set.
