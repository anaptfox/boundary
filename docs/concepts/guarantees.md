---
title: "Guarantees and counterexamples"
description: "Separate what Boundary proves at the contract seam from the evidence your application must still supply."
---

# Guarantees and counterexamples

A caller expects `{ imageId, width, height }`. A worker declares `{ jobId }`. Boundary refuses that connection before a single handler runs. Now suppose the worker declares `{ imageId, width, height }` and returns valid numbers—for an upside-down, blurry thumbnail. No contract check can see blurry pixels.

Great tools are honest about where their guarantees end. This page draws that line sharply. *(See [Availability and support](./current-status.md) for current release status.)*

> **Core conservation law:** A successful Binding and invocation conserve one selected expected interaction surface through one explicitly pinned actual realization—without silently substituting caller identity, mode, input, context, or live Installation.

## Predict the outcome

| Situation | What Boundary establishes |
| --- | --- |
| Worker declares `{ jobId }` where caller expects thumbnail dimensions | `unrealized` report; no Binding, zero dispatches |
| Handler declares `changes: ["suggestions", "document"]` where caller expects `["suggestions"]` | `unrealized: incompatible-contract`; no Binding |
| Handler declares valid output but returns malformed data at runtime | Invalid-realization fault with `certainty: "unknown"` (never disguised as a domain error) |
| Handler returns valid dimensions for a blurry image | Contract passes; visual quality requires your own tests |
| Caller selects 2 interactions; Installation implements only 1 | Atomic failure (`unrealized`); no partial Caller |
| Connection drops after a mutation may have started | `certainty: "unknown"` (or durable `uncertain` in Control); never automatic permission to retry |
| A multi-step Plan fails preflight on step 3 of 3 | Atomic preflight failure; steps 1 and 2 never start |

## 1. Compilation, Projections, and Plans

Boundary guarantees:
- Host-authored interaction IDs are preserved byte-for-byte.
- Every normative contract field (input, output, declared errors, `reads`, `changes`, optional `idempotencyKey` and `compensates`) participates in deterministic content-addressed identity (`sha256:`).
- Projections select only explicit interactions and nonempty modes; Projection identity covers only its selected surface (not unrelated Program interactions or runtime availability).
- Projection set algebra (`pick`, `omit`, `union`, `intersect`) is pure, deterministic, and rejects conflicting identities.
- Plans are acyclic, handler-free DAGs; `preflightPlan` checks every step against a Binding atomically before step 1 begins.

Compilation does not make an interaction executable, and Projection selection does not grant authority.

## 2. Installation, Binding, and Revocation

Binding checks every entry in a Projection atomically and pins:
- one Projection digest and one live Installation identity;
- each expected interaction contract to one compatible actual contract and realization ID;
- each expected mode (`direct` / `request`) to one installed contribution (plus public preview contract for `request`).

There is no partial Binding, silent latest-version following, or automatic rebinding. For live upgrades, `createBindingSlot` swaps atomically and leaves the previous live Binding intact if the new Installation fails to bind.

Revocation controllers stay host-held (never attached to execution objects passed to adapters):
- A **Binding controller** disables one caller surface.
- An **Installation controller** disables every Binding pinned to that Installation.
- Revocation blocks future calls before execution; it cannot retroactively cancel work already in flight.

## 3. Invocation and Typed Outcomes

Before dispatching to a handler or request planner, Boundary checks:
- the handle belongs to this Binding and permits the requested mode;
- input satisfies both expected and pinned actual schemas;
- host admission receives the validated input, inert policy view, and ephemeral caller context (and in `bindAuthorizedProjection`, narrows to typed `AuthorizedContext`).

Returned values and declared errors are validated before reaching the caller. On `caller.try.*`, outcomes are strictly discriminated:
- `ok`: validated output;
- `declared-error`: validated expected domain error;
- `denied`: rejected by admission (`certainty: "not-started"`);
- `fault`: infrastructure, revocation, or invalid-realization failure carrying explicit `certainty`.

Context is opaque and ephemeral: Boundary never persists, hashes, or serializes it.

## 4. Remote Handoff

**Handoff** is the only layer that accepts untrusted serialized invocation data. It verifies version, Binding identity, exact pins, mode, and input before creating an opaque checked invocation. Transports only frame bytes.

Remote clients pin a Binding manifest digest; replacing an Installation produces `stale` and requires an explicit re-handshake.

## 5. Failure Truth and Certainty

Direct outcomes distinguish four states of knowledge (`Certainty`):
- `not-started` — failed validation, admission, or revocation before dispatch;
- `not-completed` — dispatcher proved the effect did not finish;
- `completed` — validated completion;
- `unknown` — execution may have started and direct evidence cannot establish what happened.

In **Control**, durable terminal states are:
- `completed` — `apply` returned, output validated, `verify` passed, and a receipt persisted;
- `not-applied` — reconciliation established the effect did not occur;
- `uncertain` — the effect may have started and available evidence cannot prove the final state.

**Neither `unknown` nor `uncertain` is permission to retry.**

## What passing every check does *not* prove

Passing every Boundary check does **not** prove:
- that a handler implements the intended business logic;
- that declared `reads`, `changes`, `idempotencyKey`, or `compensates` traits exhaust actual side effects;
- that your authorization policy is complete or bug-free;
- that a database, network, or third-party API behaved correctly;
- that two contract-compatible implementations behave identically;
- that a deployment is secure or production-ready.

Those remain application testing and operational obligations. Use `@foxworth/boundary/testing` alongside your domain tests to verify handlers against their declared contracts.

## Conformance scope

Shared JSON conformance vectors verify that TypeScript and Rust agree on exact identity, contract compatibility, Projection, Installation, Binding, Handoff, Plan, Certainty, and Control laws for the covered vectors. They do not certify untested code paths or host domain logic.
