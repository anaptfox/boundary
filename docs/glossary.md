---
title: "Boundary glossary"
description: "Crisp definitions of Boundary's concepts mapped to the APIs and portable artifacts that carry them."
---

# Boundary glossary

Every core term in Boundary, mapped to the artifact and API that represents it.

## Everyday host terms

**Interaction**
An application-owned action described as inspectable data: stable ID, input/output schemas, optional declared errors, `reads` and `changes` footprints (global or scoped templates like `document:{input.id}`), and optional declared `idempotencyKey` / `compensates` traits.

**Portable schema (`b.*`)**
Boundary's zero-dependency schema builder (`b.object`, `b.string`, `b.integer`, `b.discriminatedUnion`, etc.) that emits strict, portable JSON Schema by construction. Zod (`z.strictObject`) compiles into the exact same portable schema profile.

**Interaction definition**
An inert value created by `defineInteraction`. Contains no handler, policy, state, or authority.

**Compiled interactions**
The synchronous, deterministic result of `compileInteractions` (or `compileInteractionsAsync` for async framework lowerings). Contains a canonical `Program`, inert `.handles`, and `.project(...)` / `.projectAll("direct")` helpers.

**Projection**
A portable, handler-free slice of interactions and modes (`direct` / `request`) selected for a caller. Supports pure set algebra (`pick`, `omit`, `union`, `intersect`) and can exist before any Installation runs.

**Realization**
One live installed contribution for `(interactionId, mode)`, paired with a host-chosen realization ID via `realizeDirect` or `realizeRequest` (or via `implementInteractions` / framework native dispatchers).

**Interaction Installation**
An immutable live snapshot pairing compiled handles with concrete realizations and an opaque live installation ID. Returns a separate host-held revocation controller.

**Projection Binding**
The atomic, checked connection pairing one Projection, one live Installation, and one admission rule. Every selected entry binds compatibly or `bindProjection` returns an exhaustive `unrealized` report—never a partial caller.

**Binding slot (`createBindingSlot`)**
A host-owned mutable handle over a live Binding that performs atomic rebinds (`slot.rebind(...)`): if the replacement Installation is incompatible, the previous live Binding stays intact.

**Caller**
A stateless typed calling interface obtained via `binding.connect()` (or returned as named `callers.*` / `tryCallers.*` from `createHost`). Supports `call(handle, ...)`, `direct.<alias>(...)`, typed-outcome `try.<alias>(...)`, and `request(handle, ...)` when request mode is bound.

**Typed outcome (`DirectOutcome` / `RequestOutcome`)**
The exhaustive discriminated union returned by `caller.try.<alias>(...)` and `createHost(...).tryCallers`: `ok`, `declared-error`, `denied` (`certainty: "not-started"`), or `fault` (carrying explicit `certainty`).

**Admission & `AuthorizedContext`**
The host-owned per-call decision made after input validation and before dispatch. With `bindAuthorizedProjection` (TS) or `bind_authorized` (Rust), admission narrows the raw caller context into a typed `AuthorizedContext` that flows directly into handlers and observed reads.

**Declared interaction error**
An expected domain alternative declared in the interaction contract, validated at runtime, and distinguished from denial or faults.

**Revocation controller**
A host-held handle returned alongside an Installation or Binding. Blocks future calls before dispatch without attaching revocation power to adapter-facing objects.

## Portable foundations & plans

**Interaction contract**
The canonical portable identity of one interaction (`boundary.interaction-contract/v1` SHA-256 digest). Covers version, ID, schemas, footprints, and optional traits; excludes runtime handlers, policy, docs annotations, arity, modes, and context.

**Program**
A serializable canonical set of interaction contracts and its deterministic `programDigest`. Carries zero handlers or authority.

**Plan (`@foxworth/boundary/plan`)**
A portable, handler-free, acyclic DAG of symbolic interaction steps (`boundary.plan/v1`). Supports deriving its minimal Projection (`planRequiredProjection`), computing parallel execution waves from disjoint footprints (`planParallelWaves`), and atomic preflight against a live Binding (`preflightPlan`) before step 1 begins.

**Draft (`@foxworth/boundary/drafts`)**
An inert artifact proposing a complete interaction contract that does not yet exist in a Program. Not callable until implemented and compiled.

**Catalog**
A portable summary of direct and request realizations contributed by one Installation. Derived from installation entries; does not alter Program identity.

**Handoff (`@foxworth/boundary/handoff`)**
The sole layer that accepts untrusted serialized invocations across a process boundary, verifying version, Binding pins, mode, and input before producing an opaque checked invocation.

**Context**
Opaque, ephemeral host data supplied on each invocation. Never persisted, hashed, or serialized by Boundary.

## Control & certainty terms

**Certainty**
What is known about an invocation's consequence: `not-started`, `not-completed`, `completed`, or `unknown`. Neither `not-completed` nor `unknown` is permission to retry.

**Controlled execution (`@foxworth/boundary/control`)**
An optional lifecycle separating request, approval, grant, leased attempt, verification, and reconciliation for consequential side effects.

**Proposal / Grant / Attempt / Lease / Receipt**
The durable records of a controlled effect: a reviewable plan (`Proposal`), explicit execution authority (`Grant`), pre-apply execution record (`Attempt`), compare-and-swap exclusivity claim (`Lease`), and verified completion evidence (`Receipt`).

**Uncertain**
The durable Control state when an effect may have started and available evidence cannot prove the final result. Must be resolved through `reconcile` (which never reruns `apply`), never blindly retried.
