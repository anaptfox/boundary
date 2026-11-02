---
title: "Boundary glossary"
description: "One word per concept, the TypeScript API that carries it, and the version 1 wire name it keeps."
---

# Boundary glossary

One tier, one word per concept. The second table maps each word to the field
name it keeps on the wire and in artifacts; those names stay until a deliberate
version 2.

## Concepts

**Interaction**

Application-owned meaningful work with a stable explicit id and portable
input, output, declared-error, read, and change contracts. Declared with
`defineInteraction`; the declaration contains no handler, policy, state, or
authority.

**Interaction contract**

The exact portable identity of one interaction: version, id, input and output
schemas, optional declared-error schema, `reads`, and `changes`. Hashed under
`boundary.interaction-contract/v1`. Implementation, policy, documentation
annotations, arity, modes, and context are outside it.

**Program**

The canonical set of interaction contracts and its digest, with no handlers,
stores, credentials, policy, or ambient authority. Inspection only on the
short path: `app.program`.

**Surface**

What one caller may see: a selection of interactions from a declaration record,
each in `call` mode, `propose` mode, or both. Created by `surface(record, { call, propose })`
or spelled out with `surface.all(record)`. A Surface is inert: it names no
implementation, admission, or context, and it may never connect. Compiled, it
becomes a portable `CompiledSurface` with its own digest.

**Installation**

Live implementations of a declaration record under host-issued identity,
created by `install(record, { version, handlers | dispatch, id? })`. Its
manifest carries the Program, the Catalog of realized modes, and the
installation digest. Only the host holds the Installation, and only it can
revoke.

**Realization**

The installed contribution for one `(interaction, mode)`, with its own
host-issued id. The short path derives ids from the host's `version`:
`<interactionId>:direct:<version>` and `<interactionId>:request:<version>`.
Changing executable behaviour means changing the version.

**Catalog**

The direct and request availability one Installation contributes, derived from
its realizations. It does not change Program identity.

**Binding**

A Surface connected to one Installation under one admission rule, created by
`app.connect(surface, { admit })`. Either every selected interaction is
realized, or the result is `unrealized` with an exhaustive report; there is no
partial caller. A Binding pins expected and actual contracts, the Installation
and realization ids, and its own digest. It never spans Installations and never
rebinds.

**Caller**

What `connect` returns: one method per `call` alias, `propose.<alias>` per
`propose` alias, the read-only Binding `manifest`, and the `handoff` seam. It
carries no controller, so handing it to an adapter cannot widen or revoke
anything. Each method takes the declared input, then the actor; zero-input
interactions take only the actor; contextless installations take neither.

**Admission**

The host's per-invocation decision, made after input validation and before
dispatch. `admit` is required on every `connect`; `admitWhen(predicate, reason)`
builds one from an actor predicate. Admission may allow or deny; a broken rule
is a fault, not a denial.

**Context**

Opaque host data supplied to each invocation; examples name the value `actor`.
The same reference reaches admission and the implementation. Boundary never
serializes, hashes, persists, or interprets it.

**Declared error**

A domain outcome the contract declares and the runtime validates, raised with
`declaredInteractionError` and narrowed with `isDeclaredInteractionError`. It
is distinct from denial, an invalid outcome, or infrastructure failure.

**Handoff**

The checked seam that accepts untrusted serialized invocations, validates
version, Binding identity, pins, mode, and input, and produces one checked
invocation. Transports only frame bytes around it; every caller carries its
seam as `caller.handoff`.

**Certainty**

What is known about one invocation's consequence: `not-started`,
`not-completed`, `completed`, or `unknown`. Neither `not-completed` nor
`unknown` is permission to retry.

## Control terms

**Proposal**

The durable, reviewable plan one `propose` call creates for an exact input
before its effect is attempted. A proposal never runs the effect.

**Grant**

Durable authority to execute one proposal under a recorded policy decision.

**Attempt**

The record persisted before applying one granted proposal, with its lease,
expiry, renewal, and fencing token.

**Receipt**

A record that apply returned, output validation passed, and the configured
verifier passed: bounded application evidence, not proof of correctness.

**Uncertain**

The durable outcome used when an effect may have started but its final result
is not known. It is reconciled, never blindly retried, and tool results say so
in those words.

## Wire and artifact names

The TypeScript API uses the words above. Version 1 artifacts and the wire keep
these field names; the specification is normative for them.

| Concept | API word | Wire or artifact name |
| --- | --- | --- |
| Caller selection | Surface, `surface()` | `projection`, `projectionDigest`, `boundary.projection/v1`, `*.projection.json` |
| Compiled selection artifact | `CompiledSurface` | `ProjectionManifest` shape: `version`, `program`, `interactions`, `projectionDigest` |
| Live conjunction | Binding, `connect()` | `binding`, `bindingDigest`, `boundary.projection-binding/v1`, `*.binding.json` |
| Binding manifest | `BindingManifest` | the version 1 Binding manifest handshake |
| Run now | `call`, method per alias | mode `direct` |
| Create a Proposal | `propose.<alias>` | mode `request` |
| Live implementations | Installation, `install()` | `installation`, `installationId`, `installationDigest`, `boundary.installation/v1` |
| Per-mode identity | `version` option | `realizationId` |
| Caller presentation | `presentSurface` | `boundary.projection-presentation/v1`, `presentationDigest` |
| Host data per call | Context (`actor`) | never on the wire |
