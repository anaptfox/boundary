---
title: "1. Model and laws"
description: "Terms and laws that govern interaction definitions, installations, and dispatch."
---

# 1. Model and laws

**Status:** Current and normative.

## Terms

An **interaction definition** is an inert native declaration of one host-authored
identity and portable contract. **CompiledInteractions** derives a handler-free
**Program**, exact inert handles, and private provenance from a closed definition
set. An **InteractionInstallation** is one live deployment of exact direct and
optional request realizations. A durable **Projection** selects expected
interactions and modes without requiring an Installation. A live
**ProjectionBinding** atomically pins that Projection to one Installation. A
**Handoff** validates and conserves one bound invocation into native dispatch.
There is no adapter-level subset of a Binding: a tool list presents the whole
Binding, and a caller that must see less is bound to a narrower Projection.

## Laws

### Declared is not implemented

A definition and Program MUST remain representable without executable code. A
Program and Projection MUST NOT require an installed realization.

### The host owns meaning and identity

Boundary MUST preserve each host-authored interaction ID byte-for-byte. It MUST NOT
move application state, policy, transactions, credentials, dispatcher, or
lifecycle into Boundary as a condition of adoption.

### Compilation derives bookkeeping, not authority

Compilation MAY derive schemas, arity, descriptors, digests, Programs, and
typed inert handles. It MUST NOT infer interaction meaning from filenames, routes,
tools, function bodies, or visibility and MUST NOT grant execution authority.

### Implementation, Installation, and Projection are distinct

An implementation supplies native behavior. An Installation makes exact
realizations live under one never-reused `InstallationId`. A Projection states
durable desired caller surface. None MAY silently stand in for another.

### Binding is atomic

Binding MUST check one complete Projection against one exact Installation and
return `bound` or an exhaustive `unrealized` report. It MUST NOT expose a
partial caller. A successful Binding MUST retain both expected and actual
identity when structural compatibility is used.

### One interaction may have direct and request modes

Portable mode values are exactly `"direct"` and `"request"`. Direct mode may
execute the interaction. Request mode may create one proposal only. Request MUST
NOT mint a synthetic interaction or convey approval, grant, execution, retry, or
reconciliation authority.

### Context is stateless and invocation-scoped

Context MUST NOT enter portable artifacts or durable records. The exact live
context reference supplied for an invocation MUST reach admission and native
dispatch without cloning or serialization.

### Handoff alone validates untrusted wire data

Transports MAY frame and carry values but MUST NOT replace Handoff validation.
The public wire protocol MUST accept version 1 only and MUST reject every other
version.

### Unknown stays unknown

Once an effect may have started, missing evidence MUST NOT become failure or
permission to retry. Invalid realization output after dispatch MUST retain
certainty `unknown` until application evidence establishes more.

### Identity is not correctness

Contract, Program, Installation, Projection, Binding, Realization, attempt, and
receipt identities establish their declared facts only. They MUST NOT be
described as behavioral equivalence, correct policy, live authority, or domain
correctness.
