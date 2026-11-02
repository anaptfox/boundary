---
title: "5. Host authoring and artifacts"
description: "Closed authoring records and portable artifacts for TypeScript Hosts."
---

# 5. Host authoring and artifacts

**Status:** Current and normative for the TypeScript Host interface.

## Closed authoring records

`defineInteraction` MUST construct one inert validated definition. A collection
MUST be an ordinary closed readonly record. Collection keys are local aliases
and MUST NOT enter portable identity. A conforming Host interface MUST NOT
require a mutable registry or shallow collection wrapper.

`compileInteractions` MUST snapshot the whole record, reject forged definitions,
duplicate IDs, invalid schemas and footprints, derive one Program and exact
inert handles, and grant no execution authority. Compilation, projection,
installation, and binding are asynchronous because each may derive a portable
identity using the shared hashing law.

`implementInteractions` MUST require exactly one correctly typed implementation
per supplied definition and reject missing, extra, and duplicate entries. A
partial deployment MUST use a smaller explicit closed record, never optional
implementations or fallback lookup.

`installInteractions` MUST create one live non-serializable Installation with a
never-reused host-issued Installation ID and exact Realization IDs. It MUST
validate realization outcomes and derive its Program and Catalog manifest.

`projectInteractions` MUST accept explicit authentic handles and mode sets and
create a portable unrealized Projection. Caller-facing Projection aliases MUST
be durable and enter Projection identity; definition-record aliases remain
local and MUST NOT. `bindProjection` MUST construct a root live Binding and
`restrictBinding` MAY derive a narrower live Binding from an existing one. Both
MUST obey the atomic Binding laws.

An unrealized result MUST retain the attempted Projection manifest, the target
Installation ID, and all realization issues. It MUST NOT expose partial live
authority.

Lifecycle transformations MUST be free functions. Methods belong only to live
capabilities: Binding connect/invoke and caller call/request. A Binding and
caller MUST store no context. Contextful `call`, `request`, and raw `invoke`
MUST take the exact invocation context as their final argument; `Context = void`
MUST elide that final argument.

## Binding restriction

`restrictBinding(parent, { projection, admit })` MUST require an authentic parent
Binding and explicit additional admission. Every child interaction ID, exact
expected contract digest, input arity, and selected mode MUST already belong to
the parent. Aliases MAY change; compatible-but-different expected contracts MUST
NOT replace the parent's expected contract. An unselected installation capability
MUST NOT become selected through restriction. Refusal MUST report every affected
selection and expose no partial live capability.
Revoked lineage MUST refuse even an empty selection. Its unrealized report MAY
have no selection issues when the Projection is empty; a synthetic interaction
ID MUST NOT be invented to name the global lifecycle refusal.

A successful child MUST retain the parent's exact Installation allocation and
mode-level actual realization pins. Admission MUST run from oldest parent to
child, with fresh decisions for every invocation and short-circuit denial. Each
rule MUST receive its corresponding bound view and the same invocation input
and exact context. The entire lineage and Installation MUST be checked before
admission and immediately before dispatch after awaited admission.

Parent revocation MUST block all descendants. Child revocation MUST NOT revoke
its parent, siblings, or Installation. Revocation cannot cancel started work.
Inherited observation delivery MUST publish once using the child's actual
outcome identity. Private policy and lifecycle lineage MUST NOT enter portable
Binding identity; a policy-only restriction MAY retain the parent's digest.
The independent Rust `restrict_binding` MUST preserve these shared laws through
its native ownership model.

## Optional native observed reads

`@foxworth/boundary/observations` MAY supply `observedRead` as a native
implementation adapter for authentic read-only definitions. Rust MAY supply its
independent native realization constructor. These interfaces MUST NOT alter caller
invocation, portable declarations, Binding identity, outcome certainty, or wire
observation envelopes.

The host MUST provide one immutable snapshot covering capture, validation, and
return of any reused value. Point evidence MUST distinguish absent from present
values and cover content. Query descriptors and evidence MUST account for the
complete resulting membership, values, ordering, and pagination, including new
matches and records shifting page boundaries. The host MUST capture every
observation needed to preserve the evaluated answer and MUST NOT treat declared
resource footprints as proof of actual read completeness.

Fresh Binding admission and helper authorization MUST precede evaluation or
reuse. Retained evidence MUST be scoped to exact input, host visibility scope,
contract, Installation, and realization. Scope MUST identify every
answer-affecting visibility distinction and MUST NOT substitute for admission.
Reusing a value MUST require all observations to validate as matching within
the current snapshot. Changed, unavailable, failed, or invalid validation MUST
fall back to fresh evaluation.

Retention MUST require successful output validation, a complete settled capture,
and successful snapshot-source completion. Read failure MUST prevent retention
even if caught by evaluation. Outstanding reads, expired views, callback errors,
invalid output, or failed source completion MUST NOT create a retained result.
Retained and returned values MUST have independently owned contents. Revoking
the Installation MUST clear and close retention. Reuse MUST default off; enabled
retention MUST be bounded, default to 128 FIFO entries, and permit zero entries
to disable retention.

TypeScript MUST snapshot JSON keys, query descriptors, visibility scopes, values,
and tokens. Rust MAY retain native owned equivalents with equality and cloning
contracts that preserve immutable identity and independent ownership. These
native authoring differences MUST NOT imply a shared wire evidence format.
Evidence and diagnostics MUST remain host-private. Diagnostic delivery failure
MUST NOT reclassify invocation truth. Correctness claims MUST be limited to the
host's snapshot, evidence-completeness, and evaluator-purity premises; the library
MUST NOT claim to capture arbitrary ambient I/O or prove a dishonest validator.

## Optional interaction-module convention

`*.boundary.ts` is an optional authoring convention over the same library compiler.
The module MUST expose a named `interactions` record. A loader MUST consume only
that export, ignore adjacent exports, and reject a factory, Promise or thenable,
mutable registry, invalid key, or forged definition.

The loader MUST receive an explicit entry and MAY use native ESM or an injected
module-loader Adapter. It MUST NOT scan directories, discover config, infer
routes, or merge modules implicitly. Authors compose several modules with
ordinary imports.

Evaluating the module or an `InteractionLowering` is arbitrary host code and MUST
NOT be described as hermetic. Determinism begins with the validated declaration
snapshot.

## Pure rendering and explicit writing

Artifact rendering MUST be pure and return exact paths and bytes in an immutable
versioned inventory. The portable outputs are explicitly named
`*.program.json`, explicitly named `*.projection.json`, and optional typed
references justified by a real package, process, build, or language seam.

Typed references MUST require explicit source-module/export metadata and MUST
NOT be generated by reverse-engineering runtime values. A request-mode typed
reference MUST receive an explicit public request-output type. Generated
runtime references MUST be structural data with type-only imports and MUST NOT
depend on a shared module instance, registry, Map, or WeakMap. Same-package
callers use local handles.

An Installation manifest MUST originate from a live Installation. A version 1
Binding manifest MUST originate from a successful live Binding. A build tool
MUST NOT synthesize either from filenames, a Program, a Projection, or config.

Filesystem writing MUST require an explicit destination and touch only files in
the supplied artifact set plus stale files named by the previous valid inventory
for that destination. It MUST NOT delete unmanaged files, infer ownership from
extensions, clean a parent directory, follow a symbolic-link destination or
managed path component, or write during loading, compilation, Projection,
Installation, or Binding construction.

Check mode MUST compare exact bytes without writing and report missing, changed,
and inventory-owned stale output. A successful check proves agreement with the
evaluated snapshot, not hermetic evaluation or realization correctness.

Generated artifacts MUST NOT overwrite reviewed conformance evidence. They are
derived output, not the authoring source of interaction meaning.

## Package seam

`@foxworth/boundary` MUST contain the direct host lifecycle and MUST NOT re-export
Program, Handoff, Control, adapter, build, or filesystem interfaces.
`@foxworth/boundary/build` owns loading, rendering, checking, and writing. The Host
root MUST NOT import its build subpath or Node built-ins. Draft propose /
accept / reject at `@foxworth/boundary/drafts` consumes Program Drafts over a
host-supplied store. A Draft is not a Program entry and MUST NOT become
callable by being stored.

Program, Handoff, and Control remain direct foundation packages. The Host root
MUST have no Control runtime dependency. Request contribution belongs to
`@foxworth/boundary/control/host` and has proposal-creation authority only. The
`@foxworth/boundary/host/control` subpath is the narrow contribution seam used by that
bridge; it is not an application-author API.

`@foxworth/boundary/observations` owns the optional observed-read helper under
the native Host implementation. The root MAY contain its private installation
integration but MUST NOT re-export its authoring interface. It MUST NOT introduce
a transport or runtime dependency into ordinary Host authoring.
