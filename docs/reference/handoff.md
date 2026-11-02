---
title: "Handoff reference"
description: "The host-neutral checked invocation seam and version 1 wire protocol."
---

# Handoff reference

`@foxworth/boundary/handoff` owns the host-neutral checked invocation seam and the
version 1 wire protocol. It validates untrusted manifests, invocations, and
outcomes. Transports only frame and carry those values; they do not establish
identity, selection, admission, or execution authority.

```text
Projection + Installation --atomic bind--> Binding
                                               |
                                               v
                                   version 1 Binding manifest
                                               |
caller input + exact context -> checked Handoff -> pinned realization
```

Handoff remains a direct foundation. It depends on `@foxworth/boundary/program` for
version 1 artifact types, not on Host. Live execution uses a narrow
`HandoffExecutable` seam that Host's Binding satisfies. Its root does not
re-export or depend on Control. Request-mode execution is contributed
separately through `@foxworth/boundary/control/host`.

## Projection binding manifest version 1

A remote handshake publishes one exact `BindingManifest` derived
from a successful live Binding:

```ts
type BindingManifest = {
  version: 1;
  bindingDigest: Sha256Digest;
  projectionDigest: Sha256Digest;
  installationId: InstallationId;
  installationDigest: Sha256Digest;
  expectedProgramDigest: Sha256Digest;
  actualProgramDigest: Sha256Digest;
  expectedProgram: Program;
  actualProgram: Program;
  actualCatalog: Catalog;
  interactions: readonly BindingInteraction[];
};

type BindingInteraction = {
  alias: string;
  interactionId: string;
  expectedContractDigest: Sha256Digest;
  actualContractDigest: Sha256Digest;
  inputArity: 0 | 1;
  mode: "direct" | "request";
  realizationId: RealizationId;
  request?: {
    controlDigest: Sha256Digest;
    previewSchema: JsonSchema;
  };
};
```

There is one canonical interaction entry per selected `(alias, mode)`, sorted by
alias and then mode using unsigned UTF-8 byte order. `request` is present
exactly when `mode` is `"request"` and absent for direct mode. The expected
Program is the durable Projection's selected contract set. The actual Program
and Catalog are the selected subset pinned from one Installation.

Validators recompute both Programs, validate the Catalog and every interaction
entry, and confirm all explicit digest fields. `boundary.projection-binding/v1`
hashes the canonical manifest without `bindingDigest`. The digest includes the
Projection digest, Installation ID and digest, durable caller aliases, expected
and actual Program and contract identities, modes, arities, realization IDs,
and request preview/control identity.

It excludes routes, context, admission code, handlers, native targets, private
Control state, liveness, and revocation authority. A valid manifest proves what
was pinned when it was created; it does not prove that its source Binding
remains live.

## Invocation version 1

Every invocation carries the exact pins needed to reject drift before
admission or dispatch:

```ts
type HandoffInvocation = {
  version: 1;
  bindingDigest: Sha256Digest;
  installationId: InstallationId;
  interactionId: string;
  expectedContractDigest: Sha256Digest;
  actualContractDigest: Sha256Digest;
  mode: "direct" | "request";
  realizationId: RealizationId;
  input: JsonValue;
};
```

The receiver validates the manifest and snapshots the complete invocation and
input before its first asynchronous step. It then checks:

- exact Binding and Installation identity;
- exact interaction, expected contract, actual contract, mode, and realization;
- structural compatibility of the already-pinned expected and actual
  contracts;
- selected input arity and portable input schema;
- request preview/control identity from the Binding manifest; and
- live revocation immediately before admission and again before dispatch.

An unknown interaction, forged handle, stale Binding, stale Installation,
contract mismatch, mode mismatch, realization mismatch, invalid arity, or
invalid input fails before native dispatch. A transport cannot weaken or skip
these checks.

Version 1 is the only Handoff protocol. Unknown or future versions are rejected.

## Stateless context and admission

Caller context is supplied per connected invocation surface and remains a live
host value. It never appears in a Program, Projection, Installation manifest,
Binding manifest, invocation envelope, outcome envelope, or persisted Control
record.

For local execution, admission and the Installation dispatcher receive the
same exact context reference. For remote execution, the server's adapter derives
context from the native request and supplies that exact reference after wire
validation. A header, cookie, token, or transport principal is input to the
host's context resolver; Handoff does not treat it as trusted identity by mere
presence.

Admission belongs to the Binding. Projection selection is not authorization,
and a valid Binding manifest is not a grant.

## Outcome version 1

Every outcome echoes the invocation pins and carries one exhaustive tagged
result plus an explicit execution certainty:

```ts
type HandoffOutcome = {
  version: 1;
  bindingDigest: Sha256Digest;
  installationId: InstallationId;
  interactionId: string;
  expectedContractDigest: Sha256Digest;
  actualContractDigest: Sha256Digest;
  mode: "direct" | "request";
  realizationId: RealizationId;
  certainty: "not-started" | "not-completed" | "completed" | "unknown";
  result:
    | { kind: "returned"; value: JsonValue }
    | { kind: "declared-error"; code: string; details: JsonValue }
    | { kind: "proposed"; proposal: JsonValue }
    | { kind: "denied"; code: string }
    | { kind: "fault"; cause: HandoffFaultCause };
};
```

The allowed combinations are:

- a validated direct return or declared domain error is `completed`;
- a request proposal is `not-started` for the target interaction under the
  trusted request-only realization contract because request mode only creates
  the proposal;
- rejection before dispatch is `not-started`;
- a fault is `not-started` only when the dispatcher proves execution did not
  begin;
- a fault is `not-completed` only when execution began and the dispatcher can
  prove the declared interaction did not reach completion; and
- a failure after dispatch is `unknown` when completion cannot be proved,
  including an invalid output or malformed claimed declared error.

An unknown host coordination failure uses `realization-failed` with `unknown`
in either mode. Request mode permits that combination while rejecting
`realization-failed` with `not-started` or `not-completed`. Ordinary request
realization failures remain `request-failed` with `not-started` when the trusted
request-only contract proves the target effect did not begin.

`not-completed` is narrower than `unknown`, but it does not prove that no
partial effect occurred and it does not authorize an automatic retry. Retry
policy and reconciliation remain host-owned.

A producer and consumer reject an invalid result/certainty combination. The
Control host bridge validates the proposed value against the request preview
and public-proposal contracts without creating a Handoff-to-Control runtime
dependency. Neither a missing response nor a transport failure may be
rewritten as `not-started` or `not-completed`. The typed `caller.call` interface
returns validated output or throws a matching `DeclaredInteractionError`; a raw
invocation exposes the full outcome.

## Checking a remote response

`validateHandoffResponse(manifest, invocation, outcome)` validates the sent input
against both pinned contracts, checks the outcome schemas and certainty, and
requires its interaction, mode, Binding, Installation, contracts, and Realization
to match the sent invocation. SurfaceClient and WebMCP's transport adapter
use this shared check. A valid response for another exposed interaction is still
an invalid response to this attempt. These identity checks do not prove which
input computed a returned value.

Validators retain fast paths only for immutable snapshots they own. Retain the
returned manifest or invocation to reuse that snapshot; passing the same mutable
input again revalidates it, including nested data.

Lost or malformed remote responses retain unknown certainty. For WebMCP direct
calls this is an unknown fault outcome. Request-mode wire faults cannot express
unknown remote completion, so WebMCP rejects with `RemoteInvocationError`
carrying `certainty: "unknown"` instead of fabricating a request-failed outcome.
Neither adapter retries the interaction.

## Native Rust Handoff surface

The `boundary_core::lifecycle` module implements the same boundary without loading
TypeScript:

```rust
let server = checked_handoff(&binding);
let manifest = server.manifest().clone();

// The host chooses how HandoffInvocation and HandoffOutcome are framed.
let caller = RemoteCaller::new(manifest, transport);
let todo = caller.call(&create_handle, CreateTodo { title }).await?;
```

`CheckedHandoff::invoke` validates the exact Binding, Installation, interaction,
expected contract, actual contract, mode, and Realization pins before
admission. Input and direct results must satisfy both the expected and actual
contract schemas. Request proposals must satisfy the pinned preview schema.
The same invocation-scoped host context reaches admission and the installed
realization; it is never serialized.

`HandoffTransport` is the only client transport seam. It carries one owned
`HandoffInvocation` and returns one untrusted `HandoffOutcome`; the typed
`RemoteCaller` validates the echoed pins, schema, mode, and certainty before it
decodes an output or declared error. A transport failure is sanitized and has
`unknown` certainty. The crate includes no HTTP, RPC, Tokio, or framework
adapter and performs no implicit retry or rehandshake.

Rust interaction errors implement `PortableFault`. The stable fault code is
definition-owned, while `details` is the error codec's validated portable
representation. The contract's error schema describes the complete
`{ code, details }` value and both languages validate that whole value.
`DeclaredErrorCodec::schema` describes native `details`; `declared_schema`
defaults to any nonempty code with those details and may be overridden with a
finite code vocabulary. A `#[derive(Fault)]` enum marked
`tag = "code", content = "details"` is the envelope itself: its schema is the
TypeScript `oneOf` (a unit variant has `null` details) and nothing is wrapped
twice. `RemoteCaller::call` reconstructs the exact native
error type from the code and details and refuses a mismatch with the native
error's `PortableFault::code`.

## Declared and remote errors

Declared errors cross in their definition-owned code and validated portable
details; the pair `{ code, details }` must satisfy the contract's error schema. Typed code narrows one with
`isDeclaredInteractionError(error, projectedHandle, code)`.

Arbitrary realization throws, framework exceptions, validation internals,
messages, stacks, and private fields do not cross. They become a stable
sanitized fault. If dispatch may have started, certainty remains `unknown`.
`HandoffError` carries stable public diagnostic code and path data; a local
diagnostic hook may retain the private cause without serializing it.

## Rehandshake and revocation

A remote client pins one `bindingDigest`. Deployment replacement, a new
`InstallationId`, a changed realization, a changed Binding, or revocation does
not silently update that client. It must perform an explicit new handshake and
pin the new version 1 Binding manifest.

Revocation prevents new admission and dispatch through the live Binding. It
cannot retract a manifest already copied elsewhere or cancel work that already
started. Remote calls against a revoked or missing Binding fail closed.

Continue with [Host](./host.md), [Program](./program.md), [Control](./control.md),
and the [normative Handoff laws](../spec/04-projections-handoffs-and-conformance.md).
