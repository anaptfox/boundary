---
title: "Host reference"
description: "Declare, compile, install, project, and bind interactions without becoming the application."
---

# Host reference

`@foxworth/boundary` is the native-host integration module. It derives exact
portable artifacts and checked callers from application-owned declarations and
implementations without becoming the application framework, dispatcher, policy
system, or state owner.

The module is library-first. File loading and artifact writes belong to the
separate [`@foxworth/boundary/build`](./build.md) entry. Draft propose /
accept / reject lives at `@foxworth/boundary/drafts`: a host-supplied store,
never a live Program mutation.

```text
definitions --compile--> CompiledInteractions --project--> Projection
     |                       |
     |                       +-- Program + inert typed handles
     |
     +--implement--> InteractionImplementations
                              |
CompiledInteractions + implementations --install--> InstalledInteractions
                                                     |          |
                                                     |          +-- host-only controller
                                                     +-- InteractionInstallation

Projection + InteractionInstallation + admission --bind--> ProjectionBinding
                                                        +-- host-only controller
                                                        +--connect--> caller
```

## Public module boundary

The root exports the host lifecycle functions and their directly owned types:

- `defineInteraction`
- `compileInteractions`
- `createHost`
- `composeCompiledInteractions`
- `diffCompiledInteractions`
- `implementInteractions`
- `installInteractions`
- `projectInteractions`
- `projectAllDirect`
- `pickProjection`
- `presentProjection`
- `assessProjection`
- `direct`
- `directRealizationIds`
- `bindProjection`
- `admitWhen`
- `admitAll`
- `declaredInteractionError`
- `isDeclaredInteractionError`
- `CreateHostError`

Lifecycle transformations are free functions. Methods belong only to values
that already own a live capability: `binding.connect`, `binding.invoke`,
`caller.call`, and, when request mode was realized, `caller.request`.

The root does not re-export Program, Handoff, Control, adapter, build, or
filesystem interfaces. Import those direct packages when their lower-level
capability is needed. In particular, the root direct-call path has no runtime
dependency on Control. The optional request bridge is owned by
`@foxworth/boundary/control/host`.

## Definitions

`defineInteraction` constructs one inert, validated interaction definition. It
contains the host-authored interaction ID, portable input and output contracts,
declared errors, and truthful `reads` and `changes` footprints. It contains no
handler, store, policy, actor, credential, transport, grant, or live authority.

```ts
export const interactions = {
  create: defineInteraction({
    id: "todos.create",
    input: createTodoInput,
    output: todo,
    errors: { duplicateTitle },
    reads: ["todos"],
    changes: ["todos"],
  }),
  list: defineInteraction({
    id: "todos.list",
    output: todoList,
    reads: ["todos"],
    changes: [],
  }),
} as const;
```

The containing record is ordinary closed TypeScript. Its keys are local aliases
for type-safe access; they do not enter interaction, Program, Projection, or wire
identity. There is no `defineInteractions` registry or mutable registration API.

## `compileInteractions`

```ts
const compiled = compileInteractions(interactions);
```

Compilation snapshots and validates the complete closed record before deriving:

- one handler-free portable `Program`;
- one exact inert typed handle per definition;
- input arity, portable contracts, and declared-error type correlation;
- private provenance needed to reject forged or foreign handles.

`CompiledInteractions` contains no implementation and grants no execution
authority. Its handles are non-callable. Compilation is deterministic for the
same validated declaration snapshot and compiler version. Native host adapters
may supply an `InteractionLowering`; evaluating that adapter is host code, so the
determinism claim begins at its validated portable output.

Compilation, projection, installation, and binding are asynchronous because
their portable identities use the shared cross-runtime hashing foundation.
Definitions, implementations, and connected callers remain synchronous values.

## `implementInteractions`

`implementInteractions` is the first-party bare-TypeScript adapter. It creates an
immutable process-local `InteractionImplementations<Definitions, Context>` with
exactly one typed implementation per supplied definition.

```ts
const implementations = implementInteractions(interactions, {
  async create(input) {
    if (await todos.containsTitle(input.title)) {
      throw declaredInteractionError(
        interactions.create,
        "duplicateTitle",
        { title: input.title },
      );
    }
    return todos.create(input);
  },
  async list() {
    return todos.list();
  },
});
```

Missing, extra, duplicate, or invalid implementations fail both statically where
TypeScript can express the law and again at construction. The value contains no
Program, Catalog, Projection, handles, manifest, availability, installation
identity, or serialization. Partial deployment uses an explicitly smaller
closed definition record whose every member is implemented exactly once; it
does not use optional implementations, fallback handlers, or a registry.

For `Context = void`, implementations receive only their interaction input. No
unused `undefined` or empty context object is introduced.

An implementation raises a declared domain error with
`declaredInteractionError(definition, code, details)`, which validates and
correlates the inert definition-owned error schema. A typed caller receives a
`DeclaredInteractionError`; use
`isDeclaredInteractionError(error, projectedHandle, code)` to narrow it. An
arbitrary throw is not a declared error.

## `createHost`

`createHost(definitions, options)` is the compact TypeScript authoring
entry for direct callers. It runs the existing compile, implementation,
installation, projection, and binding steps, then returns those authentic
values with named methods over each connected caller. It does not create a
second dispatch or authorization path.

```ts
type EditorActor = Readonly<{ role: "editor" | "assistant" }>;

const api = createHost(interactions, {
  installationId: "editor:local:v1",
  realizationVersion: "editor-handlers:v3",
  handlers: {
    move(input, _actor: EditorActor) { return editor.move(input, _actor); },
    capture(_actor: EditorActor) {
      const frozen = Object.freeze({ ...editor.position() });
      return { candidateId: editor.storeCandidate(frozen) };
    },
    render(reference, _actor: EditorActor) {
      return editor.renderStoredCandidate(reference.candidateId);
    },
  },
  callers: {
    editor: {
      direct: ["move", "capture", "render"],
      admit: (actor) => actor.role === "editor",
    },
    assistant: {
      direct: ["capture", "render"],
      admit: (actor) => actor.role === "assistant",
    },
  },
});

await api.callers.editor.move({ x: 10, y: 20 }, editorActor);
const candidate = await api.callers.assistant.capture(assistantActor);
await api.callers.editor.move({ x: 70, y: 80 }, editorActor);
await api.callers.assistant.render(candidate, assistantActor);
```

The definitions, handlers, actors, state, and admission rules remain host code.
The handler context is inferred from a typed context parameter such as
`_actor: EditorActor`; contextful named calls take `(input, actor)`, while
zero-input calls take `(actor)`. In this example, capture freezes the current
position in host-owned candidate storage and returns only a `CandidateRef` ID.
Render resolves that ID against the snapshot store, so a later move cannot
change the captured position. The host raises its declared `missingCandidate`
error if the ID is absent.
TypeScript preserves each caller's literal aliases and definition input/output
types. Every call still passes through that caller's Binding, validates input
and output, and runs its admission with the actor supplied for that call.

Both `installationId` and `realizationVersion` are required and supplied by the
host. Change the realization version when handlers change; Boundary does not
hash function source. Interaction alias `then` is reserved when exposed as a
named method. A malformed or unrealizable caller makes setup throw
`CreateHostError`; its `issues`
identify caller-specific setup failures and their causes, and setup revokes any
bindings and installation it already created without exposing a partial caller
map. Invalid global definitions or handlers can fail earlier with their own
construction errors.

The result includes `compiled`, `installation`, `installationController`,
`projections`, `bindings`, `bindingControllers`, and `callers`. These are the
same native values returned by the lower-level lifecycle, suitable for
inspection and lifecycle management. Revoke one caller through its matching
`bindingControllers` entry, or revoke all callers through
`installationController`. The helper covers direct mode only. Continue using
`projectInteractions`, `bindProjection`, and the Control bridge when a host
needs independently managed projections or request mode. Rust and the portable
contract laws are unchanged.

## `installInteractions`

Installation binds one compiled set to exact process-local execution. Bare
TypeScript pairs `CompiledInteractions` with `InteractionImplementations`; framework
adapters pair native declarations with exact native targets and a dispatcher.
Both paths produce the same `InteractionInstallation` laws.

`directRealizationIds(compiled, "v1")` builds
`{ alias: { direct: "<interactionId>:direct:v1" } }` from compiled handles. The
host still passes that record into `installInteractions`. The IDs remain
host-owned labels, not inferred at dispatch. The second argument is required: supply
a deployment or realization revision and change it whenever executable behavior
changes. Boundary does not hash function source. New installations still require
never-reused installation IDs; revised realization IDs provide an additional
pin against accidentally reusing a deployment label.

An installation requires:

- an opaque validated host-issued `InstallationId`, stable for one logical
  deployment and never reused;
- one opaque validated host-issued `RealizationId` for every
  `(interactionId, mode)` it realizes;
- exhaustive direct availability for the supplied implementation set;
- optional request contributions supplied only by `@foxworth/boundary/control/host`.

### Native dispatch outcomes

A native binding receives an exact interaction handle, inert native target,
validated input, context, and `request.outcomes`. Return only an outcome issued
by that factory:

```ts
dispatch(request) {
  if (!hostPolicyAllows(request)) {
    return request.outcomes.denied("host.policy.denied");
  }
  try {
    return request.outcomes.returned(nativeHandler(request.target, request.input));
  } catch (error) {
    return request.outcomes.unknown();
  }
}
```

The factory is private to the installed binding. Plain objects resembling an
outcome remain ordinary output and cannot claim denial, declared-error, or
fault certainty. `declared(code, details)` is checked against the exact
interaction's declared error schema. `denied` and `notStarted` preserve
`not-started`; `notCompleted` preserves `not-completed`; `unknown`, thrown
dispatch, and invalid returned data preserve `unknown`. The binding runs its
admission once and dispatches once; adapters must never retry a possibly
started interaction.

The lower-level package-private contribution seam lets the Control bridge
compose the artifact. It is not a security boundary against code already
running inside the application Host: direct callers are in the Host TCB. The
artifact is opaque and mutation-safe, while request-only behavior depends on
using the Control bridge with an honest Host-supplied plan.

```ts
const { installation, controller: installationController } =
  installInteractions(compiled, {
    installationId,
    implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
```

A request-capable entry adds `request: createRequestRealizationId` beside its
`direct` realization. Portable mode values remain exactly `"direct"` and
`"request"`.

`RealizationId` changes when the realization represented by that exact
interaction and mode changes. Direct and request modes have distinct realization
identities even when they eventually reach related application code.

The live installation is non-serializable and owns private implementations,
native targets, and dispatcher bindings. The separately returned
`InstallationController` is the only public capability that can observe or
change its revocation state. Its
`InstallationManifest` is serializable and contains the `installationId`,
canonical Program, exact Catalog, and `installationDigest`. The digest uses
`boundary.installation/v1` over the artifact schema version, Program, and Catalog. It
does not include the host-issued `installationId`, liveness, policy, context,
or handlers.

Equal installation digests establish equal declared deployment artifacts, not
the same live installation or behavioral equivalence.

`installationController.revoke()` invalidates that live Installation for every
existing and future Binding and returns `true` only for the first transition.
Invocation checks it before admission and again after admission, so revocation
that wins before dispatch returns `not-started`; it does not claim to cancel
work that already began. Adapters receive the Installation or Binding execution
value, never this host-held controller.

## `projectInteractions`

`projectInteractions` constructs a durable desired caller surface from an
explicit closed record:

```ts
const agent = projectInteractions(compiled, {
  create: direct(compiled.handles.create),
  list: direct(compiled.handles.list),
});
```

`direct(handle)` is the closed form of `{ interaction: handle, modes: ["direct"] }`.
Bare handles are not implicit all-modes.

`projectAllDirect(compiled)` selects every compiled handle in direct mode.
`pickProjection(projection, "list", "complete")` re-projects a named subset
into a new Projection with its own digest. Keys resolve as aliases first, then
as interaction ids (`todos.list`). Both lower to `projectInteractions`. A tool
list that names fewer tools than this Projection hides nothing the Binding
still carries; `pickProjection` is how a caller is given less.

Each selection names one authentic compiled handle and one non-empty set of
`"direct"` and/or `"request"` modes. Projection aliases are durable
caller-facing names and therefore enter Projection identity. Definition-record
aliases remain local and do not.

A Projection contains its exact expected subset Program, durable aliases,
arities, modes,
`projectionDigest`, and inert `projection.handles`. The digest uses
`boundary.projection/v1` over the selected Program digest and canonical alias-bearing
selections. It excludes Installations, Catalogs,
availability, implementations, authorization, context, routes, presentation,
and unselected interactions.

A Projection may remain unrealized indefinitely. Creating one does not inspect
an Installation, reject currently unavailable modes, create authority, or bind
execution.

An unrealized bind report durably retains the attempted Projection manifest,
the target Installation ID, and every issue. It never returns a partial live
Binding.

## `bindProjection`

Binding is the atomic live conjunction of one Projection, one exact
InteractionInstallation, and one explicit admission interface.

```ts
const result = bindProjection(agent, installation, {
  admit: admitWhen((ctx) => ctx.kind === "agent", "agent only"),
});

if (result.status === "unrealized") {
  report(result.report);
  return;
}

const caller = result.binding.connect();
const created = await caller.call(agent.handles.create, input, context);
```

Binding checks the whole Projection before exposing execution. It returns
exactly one of:

- `bound`, carrying a `ProjectionBinding` plus a host-held
  `BindingController`; or
- `unrealized`, carrying an exhaustive immutable report.

Missing interactions, incompatible contracts, missing modes, or mismatched
request/control identity produce `unrealized`. There is no partial Binding or
partial caller. A successful Binding pins each expected handle to one exact
actual `(interactionId, contractDigest, mode, RealizationId)` in one Installation.

## `restrictBinding`

Derive a caller with fewer interactions or modes while retaining the parent's
admission policy, exact realization pins, observer, and revocation lineage:

```ts
const reads = pickProjection(agent, "list");
const result = restrictBinding(parentBinding, {
  projection: reads,
  admit: admitWhen((context) => context.kind === "agent"),
});
```

The result has the same complete `bound` or exhaustive `unrealized` shape as
`bindProjection`. Every selected interaction, expected contract, input arity,
and mode must already belong to the parent. Aliases may be renamed; an
installation's unselected capabilities cannot be added through restriction.
Diagnostics identify `interaction-not-selected`, `contract-not-selected`,
`arity-not-selected`, or mode-specific `mode-not-selected`, with
`binding-revoked` or `installation-revoked` when the lineage is no longer live.
Restriction of a revoked lineage also refuses an empty Projection. That global
lifecycle refusal has an empty `issues` list because no selection exists to
name; its `unrealized` status exposes no live Binding.

Admission runs from the oldest parent to the child, stopping at the first
denial. Each rule sees its corresponding bound contract view and the same
normalized input and exact context. Parent policy runs afresh for every call;
restriction does not snapshot an earlier allow decision. The inherited observer
publishes once, using the child's outcome identity and correlation.

Revoking the parent or Installation blocks dispatch through every descendant.
Revoking a child affects that child and its descendants, leaving its parent and
siblings live. Liveness is checked before admission and again immediately
before dispatch after awaited admission. Revocation does not cancel work that
already began. Admission and revocation lineage remain private: adding policy
alone does not change the portable Binding digest.

Rust exposes `restrict_binding(&parent, &projection, additional_admission)` with
the same subset and lifecycle laws. Its `RestrictedAdmission` retains parent
policy ownership without keeping a borrow of the parent Binding.
Compatible expected and actual contracts retain both identities; neither is
silently rewritten.

The Binding is non-serializable and never silently rebinds when a new
Installation appears. Its separate `BindingController` provides idempotent
revocation, checked before admission and immediately before dispatch. The
Binding passed to adapters has no revocation method. Revocation cannot claim to
cancel work that already started.

Its `ProjectionBindingManifest` is data only. It pins the Projection,
Installation, expected and actual selected Programs and contracts, modes,
arities, realization IDs, and request preview/control identity. It excludes
admission code, context, native targets, handlers, liveness, and revocation
authority. The manifest and its `bindingDigest` do not prove that a live Binding
still exists.

## Context and callers

A Binding and caller store no caller context. `binding.connect()` creates the
caller capability. Each contextful invocation supplies context last:
`caller.call(handle, input, context)`, `caller.request(handle, input, context)`,
or raw `binding.invoke(invocation, context)`. The same exact reference reaches
admission and native dispatch; it is never cloned, serialized into artifacts,
or persisted in Control records. For `Context = void`, the final argument is
elided.

`caller.call(handle, input, context)` performs direct execution.
`caller.request(handle, input, context)` exists only when the request bridge
contributed that exact mode and
creates a proposal only. It cannot approve, grant, execute, reconcile, or retry
the target effect.

Typed calls validate inputs before admission and validate returned values and
declared errors after dispatch. An invalid returned value or malformed claimed
declared error becomes a stable Boundary fault with certainty `unknown` and cause
`invalid-realization-outcome`: dispatch may already have caused an effect. Raw
`binding.invoke` exposes the corresponding exhaustive identity-bearing outcome.

Continue with [Host build](./build.md), [Program](./program.md),
[Handoff](./handoff.md), and [Control](./control.md).

## Empty surfaces, observations, and agent presentation

`projectInteractions(compiled, {})` and `pickProjection(projection)` produce an
authentic empty Projection. It can bind, handshake, and be revoked, with no
callable interactions. Every selected interaction still requires at least one mode.
An empty binding does not grant an observation subscription; the host separately
chooses who can receive events.

An optional observer on `bindProjection` publishes one validated observation
for each resolved invocation outcome:

```ts
const bound = bindProjection(agentProjection, installation, {
  admit,
  observation: {
    correlate: (context) => ({ run: context.runId }),
    publish: (event) => hostEvents.publish(event),
  },
});
```

Publication is awaited. Publication failure cannot change the invocation result,
and a failed correlation function omits correlation. The observer receives exact
binding, projection, installation, contract, and realization pins, mode, certainty,
result kind, and actual contract footprints. Inputs, outputs, and context are
excluded; correlation is explicitly host-selected portable JSON. The host owns
timeouts, delivery, persistence, access control, ordering, and replay. This is
neither a durable event bus nor an exactly-once delivery guarantee.

`invalidateReadsForObservation(event, scope)` from `@foxworth/boundary/client`
refreshes intersecting mounted reads belonging to the same installation identity
and digest. Completed, not-completed, and unknown outcomes may refresh reads;
not-started outcomes do not. It never retries the mutation. Validate and
authenticate the host-chosen event channel before delivering events to a UI.

`presentProjection(projection, { alias: { title, description } })` returns an
inspectable agent presentation. Only prose can be overridden. Interaction identity,
modes, arity, input schema, direct output/error schemas, and footprints come from
the selected declaration. Request-only selections omit direct output/error
schemas: a Projection cannot invent a realization's proposal schema. Empty
presentations have an empty interactions array.

The presentation has its own `presentationDigest`; editing prose changes that
digest without changing `projectionDigest` or callable identity. Persist the
presentation artifact and its digest with a run to record the declared tool
surface shown to an agent. The host still owns additional prompts, tool protocol
formatting, model configuration, admission, and execution.

## Assessing a candidate deployment

`assessProjection(projection.manifest, installation.manifest)` compares the
contracts and mode availability claimed by two candidate artifacts without
constructing a Binding. It returns `status: "fit" | "mismatch"`, ordered `issues`,
and `missingEvidence`. Live `bindProjection` uses the same interaction assessment
for contract compatibility and mode availability, then supplies its additional
native evidence and constructs the Binding atomically.

```ts
import { assessProjection } from "@foxworth/boundary";

const report = assessProjection(projection.manifest, candidateManifest);
// report.issues identifies missing interactions, incompatible contracts,
// and missing direct/request realizations.
```

`fit` describes declared data only. The report always lists artifact authenticity,
actual input arity, live revocation, and admission as missing evidence. Candidate
artifacts do not carry those facts. A host must authenticate candidate artifacts
through its own distribution process and still call `bindProjection` with a live
Installation and explicit admission before invocation. A digest-shaped field in
candidate input is not proof of authenticity. The function snapshots portable JSON
before inspection; it does not retain mutable caller data or execute accessors.

This assessment helper is a native TypeScript capability. It adds no portable
artifact, grant, executable plan, or cross-language parity claim.

## Drafts

`@foxworth/boundary/drafts` ships three ordinary interactions over Program
Drafts: `drafts.propose`, `drafts.accept` and `drafts.reject`
(`draftsPropose`, `draftsAccept`, `draftsReject`, collected as
`draftsInteractions`). `proposeDraft`, `acceptDraft` and `rejectDraft` are the
same logic for a host that calls it directly or hands it to
`implementInteractions` or a Control request contribution.

The host supplies a `DraftStore` with four methods: `put`, `get`, `list` and
`recordDecision`. Boundary reads and writes it only inside those three
interactions. Accepting a Draft returns its checked contract and digest; it
never mutates a live Program, Installation or source file. Declaring the
accepted contract is the host's ordinary recompilation. A rejection carries one
of `DRAFT_REJECT_REASONS`.

Three Projection presets split the authority: `proposerProjection` selects
propose only, `authorProjection` selects accept and reject in request mode,
and `runnerProjection` selects nothing. No preset grants every Draft
capability; a host that wants that composes its own Projection from
`compiled.handles`.
