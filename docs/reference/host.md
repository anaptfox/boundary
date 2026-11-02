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
definitions --compile--> CompiledInteractions --project--> CompiledSurface
     |                       |
     |                       +-- Program + inert typed handles
     |
     +--implement--> InteractionImplementations
                              |
CompiledInteractions + implementations --install--> InstalledInteractions
                                                     |          |
                                                     |          +-- host-only controller
                                                     +-- InteractionInstallation

CompiledSurface + InteractionInstallation + admission --bind--> Binding
                                                        +-- host-only controller
                                                        +--connect--> caller
```

## Public module boundary

The root exports the short path and the values it is made of:

- `defineInteraction`, `declaredInteractionError`, `isDeclaredInteractionError`
- `surface` and `surface.all`
- `install`, returning an `Installation` with `connect`, `tryConnect`,
  `revoke`, and `binding`
- `admitWhen` and `admitAll`
- `ConnectError`, `HostError`, `InteractionFault`, `DeclaredInteractionError`

The explicit pipeline (`compileInteractions`, `implementInteractions`,
`installInteractions`, `projectInteractions`, `bindSurface`,
`restrictBinding`, `bindNativeInteractions`, `projectSurface`,
`realizationIdsFor`, `createCaller`, `presentSurface`, `assessSurface`,
`describeBinding`) is exported from `@foxworth/boundary/pipeline`. The root
still re-exports most of it during the migration; that duplication ends when
the root settles on the short path.

Lifecycle transformations are free functions. Methods belong only to values
that already own a live capability: `app.connect`, `caller.<alias>`,
`caller.propose.<alias>`, `binding.invoke`, and the pipeline's `binding.connect`
and `caller.call`.

The root does not re-export Program, Handoff, Control, adapter, build, or
filesystem interfaces. Import those direct packages when their lower-level
capability is needed. In particular, the root direct-call path has no runtime
dependency on Control. The optional request bridge is owned by
`@foxworth/boundary/control/host`.

## The short path

`surface`, `install`, and `connect` are the TypeScript entry the README
teaches. They compose the explicit pipeline and return its artifacts; they add
no behaviour of their own.

A **Surface** selects what one caller may see from a declaration record:
`call` aliases are callable directly, `propose` aliases yield a Proposal record
for host review. Nothing is selected by default and `surface.all(record)`
spells out the everything case. A Surface is inert: it names no
implementation, admission, or context, and it may stay unconnected forever.

```ts
const editorSurface = surface(scene, { call: ["move", "capture", "render"] });
const assistantSurface = surface(scene, { call: ["capture", "render"] });
```

`install` compiles the record and installs its handlers. The host owns
`version`, the release label of the installed realizations; Boundary never
derives it from code. `id` is optional and defaults to a visible
`generated:...` token; a host that publishes Reach records or persists Control
state passes its own. The executable [scene example](../../examples/snippets/typescript/scene-authoring.ts)
keeps its state in plain `Map` values:

<!-- snippet:examples/snippets/typescript/scene-authoring.ts#install -->
```ts
const app = await install(sceneInteractions, {
  id: "scene:local:v1",
  version: "scene-handlers:v1",
  handlers: {
    move(input, _actor: SceneActor) {
      const previous = positions.get(input.id);
      if (!previous) throw new Error(`Unknown scene item: ${input.id}`);
      const next = Object.freeze({
        x: input.x,
        y: input.y,
        revision: previous.revision + 1,
      });
      positions.set(input.id, next);
      return Object.freeze({ id: input.id, ...next });
    },
    capture(_actor: SceneActor) {
      const current = positions.get("orb");
      if (!current) throw new Error("The scene item is unavailable");
      const candidateId = `scene-candidate-${nextCandidateId++}`;
      candidates.set(candidateId, Object.freeze({ id: "orb", ...current }));
      return { candidateId };
    },
    render(reference, _actor: SceneActor) {
      const candidate = candidates.get(reference.candidateId);
      if (!candidate) {
        throw declaredInteractionError(
          sceneInteractions.render,
          "missingCandidate",
          { candidateId: reference.candidateId },
        );
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle data-revision="${candidate.revision}" cx="${candidate.x}" cy="${candidate.y}" r="5"/></svg>`;
    },
  },
});
```

The handler context type is inferred from the handlers' typed actor parameters.
One Installation has one context type. `install(..., { dispatch: { targets,
dispatchers } })` installs native dispatchers over host-owned targets instead
of handlers, and `requests: (compiled) => contributeControlRequests(...)` adds
the Control request bridge so `propose` aliases can connect.

`connect` binds a Surface to the Installation and returns a caller. `admit` is
required by the type; there is no admit-all default, and holding a Surface or
a caller is never authority. The admission rule runs on every call with that
call's actor.

<!-- snippet:examples/snippets/typescript/scene-authoring.ts#connect -->
```ts
const editor = await app.connect(surface.all(sceneInteractions), {
  admit: admitWhen((actor: SceneActor) => actor.role === "editor", "Editor required"),
});
const assistant = await app.connect(surface(sceneInteractions, { call: ["capture", "render"] }), {
  admit: admitWhen((actor: SceneActor) => actor.role === "assistant", "Assistant required"),
});
```

A caller has one method per `call` alias and `propose.<alias>` per `propose`
alias. Methods take the declared input followed by the actor; zero-input
interactions take only the actor, and contextless installations take neither.
The assistant has no `move` method:

<!-- snippet:examples/snippets/typescript/scene-authoring.ts#call-sequence -->
```ts
export async function runSceneAuthoringSequence() {
  const scene = await createSceneAuthoringExample();
  await scene.callers.editor.move({ id: "orb", x: 18, y: 24 }, scene.actors.editor);
  const captured = await scene.callers.assistant.capture(scene.actors.assistant);
  await scene.callers.editor.move({ id: "orb", x: 71, y: 83 }, scene.actors.editor);
  return scene.callers.assistant.render(captured, scene.actors.assistant);
}
```

A caller also carries its read-only `manifest` and a `handoff` seam
(`manifest`, `resolve`, `invoke`) for adapters that validate serialized
invocations into this exact Binding. It carries no controller: `app.revoke(caller)`
revokes that caller's Binding and `app.revoke()` revokes the whole
Installation, and only the host holds `app`. `app.binding(caller)` returns the
real `Binding` for inspection and Handoff tooling; `app.program`,
`app.compiled`, `app.installation`, and `app.manifest` are the pipeline's own
artifacts.

When the Surface cannot be realized, `connect` throws `ConnectError`. It
carries the exhaustive unrealized `report` and three agent-readable strings:
`expected` (what the Surface required), `found` (one line per issue), and
`fix` (what to change). `tryConnect` returns `{ status: "unrealized", report }`
instead of throwing and accepts a Surface over any declarations, because a
disagreement is what the report is for.

Connecting compiles the Surface's own declarations for the expected side of
the Binding. A Surface built from a record whose `suggest` only changes
suggestions is refused by an installation whose `suggest` also changes the
document, even when the interaction id, input, and output are unchanged. The
README's document-review example shows that refusal.

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
for type-safe access; they do not enter interaction, Program, Surface, or wire
identity. There is no `defineInteractions` registry or mutable registration API.

## `compileInteractions`

```ts
const compiled = await compileInteractions(interactions);
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

Compilation, surface, installation, and binding are asynchronous because
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
Program, Catalog, Surface, handles, manifest, availability, installation
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

## `installInteractions`

Installation binds one compiled set to exact process-local execution. Bare
TypeScript pairs `CompiledInteractions` with `InteractionImplementations`; framework
adapters pair native declarations with exact native targets and a dispatcher.
Both paths produce the same `InteractionInstallation` laws.

`realizationIdsFor(compiled, "v1", { request: ["publish"] })` builds
`{ alias: { direct: "<interactionId>:direct:v1" } }` for every compiled alias
and adds `request: "<interactionId>:request:v1"` for the aliases listed under
`request`. It is the same derivation `install(..., { version })` performs. The
host still passes that record into `installInteractions`. The IDs remain
host-owned labels, not inferred at dispatch. The version is required: supply
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

The lower-level `@foxworth/boundary/host/control` export exists so that package can
compose the artifact. It is not a security boundary against code already
running inside the application Host: direct callers are in the Host TCB. The
artifact is opaque and mutation-safe, while request-only behavior depends on
using the Control bridge with an honest Host-supplied plan.

```ts
const { installation, controller: installationController } =
  await installInteractions(compiled, {
    installationId,
    implementations,
    realizationIds: realizationIdsFor(compiled, "v1"),
  });
```

A request-capable entry adds `request: createRequestRealizationId` beside its
`direct` realization. Portable mode values remain exactly `"direct"` and
`"request"`; the short path's `call` and `propose` verbs map onto them.

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
const agent = await projectInteractions(compiled, {
  create: { interaction: compiled.handles.create, modes: ["direct"] },
  list: { interaction: compiled.handles.list, modes: ["direct"] },
});
```

Bare handles are not implicit all-modes. `projectSurface(compiled, surface)`
is the same step driven by a Surface: `projectSurface(compiled, surface.all(docs))`
selects every alias in direct mode and
`projectSurface(compiled, surface(docs, { call: ["list"], propose: ["publish"] }))`
selects by alias. Every selected alias must name the definition this
compilation compiled; a Surface over another record is refused. A tool list
that names fewer tools than this selection hides nothing the Binding still
carries; a narrower Surface is how a caller is given less.

Each selection names one authentic compiled handle and one non-empty set of
`"direct"` and/or `"request"` modes. Surface aliases are durable
caller-facing names and therefore enter Surface identity. Definition-record
aliases remain local and do not.

A Surface contains its exact expected subset Program, durable aliases,
arities, modes,
`projectionDigest`, and inert `projection.handles`. The digest uses
`boundary.projection/v1` over the selected Program digest and canonical alias-bearing
selections. It excludes Installations, Catalogs,
availability, implementations, authorization, context, routes, presentation,
and unselected interactions.

A Surface may remain unrealized indefinitely. Creating one does not inspect
an Installation, reject currently unavailable modes, create authority, or bind
execution.

An unrealized bind report durably retains the attempted Surface manifest,
the target Installation ID, and every issue. It never returns a partial live
Binding.

## `bindSurface`

Binding is the atomic live conjunction of one Surface, one exact
InteractionInstallation, and one explicit admission interface.

```ts
const result = await bindSurface(agent, installation, {
  admit: admitWhen((ctx) => ctx.kind === "agent", "agent only"),
});

if (result.status === "unrealized") {
  report(result.report);
  return;
}

const caller = result.binding.connect();
const created = await caller.call(agent.handles.create, input, context);
```

Binding checks the whole Surface before exposing execution. It returns
exactly one of:

- `bound`, carrying a `Binding` plus a host-held
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
const reads = await projectSurface(compiled, surface(docs, { call: ["list"] }));
const result = await restrictBinding(parentBinding, {
  projection: reads,
  admit: admitWhen((context) => context.kind === "agent"),
});
```

The result has the same complete `bound` or exhaustive `unrealized` shape as
`bindSurface`. Every selected interaction, expected contract, input arity,
and mode must already belong to the parent. Aliases may be renamed; an
installation's unselected capabilities cannot be added through restriction.
Diagnostics identify `interaction-not-selected`, `contract-not-selected`,
`arity-not-selected`, or mode-specific `mode-not-selected`, with
`binding-revoked` or `installation-revoked` when the lineage is no longer live.
Restriction of a revoked lineage also refuses an empty Surface. That global
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

Its `BindingManifest` is data only. It pins the Surface,
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

`projectInteractions(compiled, {})` and `projectSurface(compiled, surface(docs, {}))`
produce an authentic empty selection. It can bind, handshake, and be revoked, with no
callable interactions. Every selected interaction still requires at least one mode.
An empty binding does not grant an observation subscription; the host separately
chooses who can receive events.

An optional observer on `bindSurface` publishes one validated observation
for each resolved invocation outcome:

```ts
const bound = await bindSurface(agentProjection, installation, {
  admit,
  observation: {
    correlate: (context) => ({ run: context.runId }),
    publish: (event) => hostEvents.publish(event),
  },
});
```

Publication is awaited. Publication failure cannot change the invocation result,
and a failed correlation function omits correlation. The observer receives exact
binding, surface, installation, contract, and realization pins, mode, certainty,
result kind, and actual contract footprints. Inputs, outputs, and context are
excluded; correlation is explicitly host-selected portable JSON. The host owns
timeouts, delivery, persistence, access control, ordering, and replay. This is
neither a durable event bus nor an exactly-once delivery guarantee.

`invalidateReadsForObservation(event, scope)` from `@foxworth/boundary/client/cache`
refreshes intersecting mounted reads belonging to the same installation identity
and digest. Completed, not-completed, and unknown outcomes may refresh reads;
not-started outcomes do not. It never retries the mutation. Validate and
authenticate the host-chosen event channel before delivering events to a UI.

`presentSurface(projection, { alias: { title, description } })` returns an
inspectable agent presentation. Only prose can be overridden. Interaction identity,
modes, arity, input schema, direct output/error schemas, and footprints come from
the selected declaration. Request-only selections omit direct output/error
schemas: a Surface cannot invent a realization's proposal schema. Empty
presentations have an empty interactions array.

The presentation has its own `presentationDigest`; editing prose changes that
digest without changing `projectionDigest` or callable identity. Persist the
presentation artifact and its digest with a run to record the declared tool
surface shown to an agent. The host still owns additional prompts, tool protocol
formatting, model configuration, admission, and execution.

## Assessing a candidate deployment

`assessSurface(projection.manifest, installation.manifest)` compares the
contracts and mode availability claimed by two candidate artifacts without
constructing a Binding. It returns `status: "fit" | "mismatch"`, ordered `issues`,
and `missingEvidence`. Live `bindSurface` uses the same interaction assessment
for contract compatibility and mode availability, then supplies its additional
native evidence and constructs the Binding atomically.

```ts
import { assessSurface } from "@foxworth/boundary";

const report = assessSurface(projection.manifest, candidateManifest);
// report.issues identifies missing interactions, incompatible contracts,
// and missing direct/request realizations.
```

`fit` describes declared data only. The report always lists artifact authenticity,
actual input arity, live revocation, and admission as missing evidence. Candidate
artifacts do not carry those facts. A host must authenticate candidate artifacts
through its own distribution process and still call `bindSurface` with a live
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

Three Surface presets split the authority: `proposerSurface` selects
propose only, `authorSurface` selects accept and reject in request mode,
and `runnerSurface` selects nothing. No preset grants every Draft
capability; a host that wants that composes its own Surface from
`compiled.handles`.
