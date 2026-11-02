---
title: "Boundary glossary"
description: "Host, Program, Handoff, Control, and related terms used throughout Boundary."
---

# Boundary glossary

This page defines Boundary's concepts and maps them to the TypeScript APIs and
artifacts that carry them.

## Host integration terms

**Interaction**

Application-owned meaningful work with a stable explicit ID and portable
input, output, declared-error, read, and change contracts.

**Interaction definition**

An inert author-owned value created by `defineInteraction`. It contains no
handler, policy, state, lifecycle, or authority. A plain `as const` record of
definitions is the normal bare-TypeScript source.

**Compiled interactions**

The deterministic result of compiling a closed definition record or lowering
native host declarations. It contains a Program and inert typed `.handles`.

**Compiled handle**

An inert typed reference to one compiled interaction contract. It is useful for
constructing a Projection or Installation; it is not callable authority.

**Interaction implementations**

A process-local immutable Adapter created by `implementInteractions` for bare
TypeScript. It gives every supplied definition exactly one correlated
implementation and owns no availability, policy, Control, or lifecycle.

**Interaction Installation**

One live immutable availability snapshot that binds exact interaction handles to
native targets and dispatchers or bare implementations. It has an opaque live
identity and derives its Catalog. Its separately returned host controller owns
revocation authority.

**Installation manifest**

A versioned portable Program-and-Catalog description of an Installation. It is
not the live capability and does not prove implementation behavior.

**Projection**

A portable exact expected caller surface: explicit aliases and interactions.
Each selected interaction has a nonempty set of direct or request modes. The
surface may select zero interactions and may remain unrealized indefinitely. It
contains no Installation, admission, dispatcher, or context.

**Projected handle**

An inert caller-facing handle from `projection.handles`. Its type is restricted
to the modes selected by that Projection.

**Projection Binding**

The atomic live conjunction of one Projection, one Installation, and one
admission Adapter. Every selected entry binds or the result is `unrealized`;
there is no partial Binding or automatic rebinding.

**Projection Binding manifest**

A versioned portable description of a Binding's expected-to-actual pins,
durable aliases, selected modes, Realization IDs, live Installation identity,
and binding digest. It carries no admission policy, context, execution
capability, or liveness guarantee.

**Revocation controller**

A host-held capability returned beside an Installation or successful Binding.
It can revoke that exact live value. Execution values passed to adapters do not
carry the controller.

**Caller**

A stateless typed calling Interface obtained from a Binding. Each `call` or
`request` receives context as its final argument; contextless callers omit it.

**Admission**

The host-owned per-invocation decision made after input validation and before
dispatch or request planning. Admission may allow or deny; a broken admission
Adapter is a fault, not a denial.

**Declared interaction error**

An expected domain alternative declared by the interaction contract and
validated at runtime. It is distinct from denial, invalid realization output,
or infrastructure failure.

## Portable foundations

**Interaction contract**

The exact portable identity of one interaction: version, host-authored ID, input
and output schemas, optional declared-error schema, `reads`, and `changes`.
`boundary.interaction-contract/v1` hashes those fields. Runtime implementation, policy,
documentation annotations, arity, modes, and context are excluded. Arity
belongs to Projection and Binding artifacts.

**Program**

A serializable canonical set of interaction contracts and its digest. It
contains no handlers, stores, credentials, policy, or ambient authority.

**Draft**

An inert artifact proposing one full interaction contract that does not yet
exist. It wraps that complete contract plus a gap, opaque proposer, and
host-supplied timestamp. It is not a Program entry and is not callable.

**Realization**

The exact installed contribution for one `(interactionId, mode)`. Direct and
request modes have distinct host-issued Realization IDs. Changing that
contribution requires a new Realization ID.

**Catalog**

A portable description of the direct and request availability contributed by
one Installation. It is derived from exact installation entries and does not
change Program identity.

**Handoff**

The foundation that accepts untrusted serialized invocation data, validates
version, Binding identity, exact pins, mode, and input, and produces an opaque
checked invocation. Transports only frame bytes around it.

**Context**

Opaque ephemeral host data supplied to each invocation. The same reference
reaches admission and native dispatch. Boundary does not serialize, hash, enrich,
persist, or interpret it.

## Control terms

**Controlled execution**

An optional path that separates request, review, authority, attempt,
verification, and recovery. It is owned by Control, not Host.

**Proposal**

A durable reviewable plan for one exact interaction input before its effect is
attempted.

**Grant**

Durable authority to execute one proposal under a recorded policy decision.

**Attempt**

The record persisted before applying one granted proposal.

**Lease**

The compare-and-swap claim on an active attempt, including expiry, renewal, and
a fencing token.

**Receipt**

A record that apply returned, output validation passed, and the configured
verifier passed. It is bounded application evidence, not proof of correctness.
There is no generic Host Installation receipt in the target.

**Uncertain**

The durable Control outcome used when an effect may have started but its final
result is not known. It is the persisted form of an invocation's `unknown`
certainty. It must be reconciled rather than blindly retried.

**Certainty**

What is known about one invocation's consequence: `not-started`,
`not-completed`, `completed`, or `unknown`. Binding outcomes, Handoff
outcomes, native dispatch faults, and guest faults all use these four words.
Neither `not-completed` nor `unknown` is permission to retry.
