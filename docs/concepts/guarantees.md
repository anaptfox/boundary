---
title: "Guarantees and counterexamples"
description: "Separate the checks Boundary performs from the evidence your application must supply."
---

# Guarantees and counterexamples

A caller asks for a thumbnail ID and dimensions. A worker declares that it
returns only a job ID. Boundary refuses that connection before dispatch. If the
worker declares the right output but produces a poor image, the contract alone
cannot detect that defect.

This page separates the checks Boundary performs from the evidence your application
must supply. See [current availability](./current-status.md) for release status.

> A successful Binding and invocation conserve one selected expected interaction
> surface through one explicitly pinned actual realization without silently
> substituting caller identity, mode, input, context, or live Installation.

## Predict the result

| Situation | What Boundary establishes |
| --- | --- |
| Worker declares a job ID where the caller expects thumbnail dimensions | Incompatible connection; no Binding |
| Worker declares thumbnail dimensions but returns malformed output | Invalid-realization fault; consequence remains unknown |
| Worker returns valid dimensions for an ugly image | Contract can pass; visual quality needs application tests |
| Caller selects two interactions; host realizes only one | No partial Binding |
| Tool list hides an interaction that is still in the Binding | Visibility changed; admission still governs calls |
| A mutation may have started and its response is lost | Unknown consequence; no automatic permission to retry |

## Compilation and Surface

The target checks that:

- the host-authored interaction ID is preserved byte-for-byte;
- every normative portable contract field participates in identity;
- compilation is deterministic for the same validated in-memory definitions;
- a Surface contains only explicit compiled interactions and nonempty modes;
- Surface identity covers only its selected expected surface, aliases,
  arity, and modes, not unrelated Program interactions or runtime availability;
- a Surface can remain valid with zero Installations.

Compilation does not make an interaction executable. Surface selection does
not grant authority.

## Installation and Binding

An Installation derives availability from exact per-handle binding entries.
Binding checks every Surface entry atomically. A successful Binding pins:

- one Surface and one live Installation identity;
- each expected interaction contract to one structurally compatible actual
  contract and concrete realization;
- each expected mode to one installed contribution;
- request contribution identity and public preview contract when present.

The whole bind succeeds or returns an exhaustive `unrealized` report. There is
no partial Binding, latest-version following, silent replacement, or automatic
rebinding. A host-held Binding controller disables one caller surface; an
Installation controller disables every Binding pinned to that live deployment.
Execution values passed to adapters carry no revoke method. Either controller
makes future calls fail before execution and cannot retroactively cancel work
that already began.

Compatibility is directional and explicit. It does not assert that two
realizations behave the same.

## Invocation

Before native dispatch or request planning, the target checks:

- the projected handle belongs to the Binding and permits the requested mode;
- caller input satisfies the expected and pinned actual contracts;
- admission receives the exact handle, mode, validated input, inert policy
  view, and caller-supplied context;
- only the dispatcher receives executable native capability.

Returned values and declared errors are validated against actual and expected
contracts before reaching the caller. An invalid output, wrong declared error,
or invalid declared-error payload becomes a stable invalid-realization fault
with execution certainty `unknown`; it is never reclassified as a domain error.

Context is opaque, ephemeral, and supplied per invocation. Boundary never persists,
hashes, serializes, enriches, or treats it as a service locator.

## Remote calls

Handoff is the only layer that accepts untrusted serialized invocation data.
It validates the versioned Binding identity, exact pins, mode, and input before
producing an opaque checked invocation. Transports parse and frame bytes; they
do not reconstruct conservation rules.

Remote clients pin a Binding manifest and digest. Installation
replacement produces `stale` and requires an explicit new handshake. A manifest
describes identity and selected availability; it is not live authority.

## Direct and controlled failure truth

Direct outcomes distinguish:

- failure before execution started;
- dispatcher-proven non-completion;
- `unknown`, when execution may have started and direct evidence cannot prove
  the outcome.

Only Control owns a durable `uncertain` Attempt reference and reconciliation.
Its terminal classifications remain:

- `completed`: apply returned, output validation passed, verification passed,
  and a receipt persisted;
- `not-applied`: reconciliation established that the effect did not occur;
- `uncertain`: the effect may have started and available evidence cannot
  establish the final state.

Neither `unknown` nor `uncertain` is permission to retry.

## What is not proved

Passing every Boundary check does not prove:

- that a realization implements the intended business meaning;
- that declared reads and changes exhaust its actual effects;
- that application policy is correct or complete;
- that a transaction, store, network, or third party behaved correctly;
- that compatible contracts or separate implementations are behaviorally
  equivalent;
- that a UI, route, tool, deployment, or host is secure or production ready.

Those remain application evidence obligations.

## Conformance

Conformance vectors can establish that TypeScript or Rust obeyed specific
identity, compilation, Surface, Installation, Binding, Handoff, certainty,
and Control laws for those vectors. They do not certify untested behavior or
the host's domain implementation.
