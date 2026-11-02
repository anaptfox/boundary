---
title: "3. Control and recovery"
description: "Authority, proposal, grant, effect, and reconciliation for consequential interactions."
---

# 3. Control and recovery

**Status:** Current and normative.

## Capability separation

The direct Host module MUST NOT depend on or re-export Control. Request-mode
Installation contributions MUST be owned by `@foxworth/boundary/control/host` and MUST
have create-proposal authority only.

Portable `ControlReader` observation is `get`, `status`, and `list`. Those
methods MUST NOT approve, grant, execute, or reconcile. A native host MAY add
bounded pagination (`page`) that is not a portable Control interaction and MUST
NOT broaden Reader authority or imply Admin capability. `ControlAdmin` MUST
own `approve`, `grant`, `execute`, and `reconcile`. `caller.request` MUST
create a proposal only and MUST NOT be a Reader or Admin capability.

## Request order

A request MUST execute this order:

1. validate the version 1 Binding pins, exact mode, input arity, and input;
2. evaluate Binding admission;
3. call and validate `plan` against current host reality;
4. evaluate Control request policy against the exact proposal candidate;
5. persist the private proposal; and
6. return its public form.

Admission denial, Control policy denial, and planning/validation/journal faults
MUST remain distinct. `plan` MUST NOT perform the target effect. A successful
proposal outcome has certainty `not-started` for the target interaction.

Request is a mode of the original interaction. It MUST NOT create a synthetic
interaction identity. A target contract change is a normal versioned break.

## Realization contract

A controlled target MUST supply `plan`, `apply`, `verify`, and `reconcile`,
schemas for private state and public preview, and a digest of its packaged
executable realization. Function source MUST NOT be hashed as artifact identity.

`boundary.control-realization/v1` MUST hash exactly the static identity fields
`interactionId`, `interactionContractDigest`, `realizationDigest`, `stateSchema`, and
`previewSchema`. The Installation identity and final runtime pins MUST NOT enter
this digest: an Installation digest already contains the Catalog's control
digest, so including it would create an identity cycle.

After admission, Host MUST supply a frozen `RequestInvocationPolicy` containing
request mode, Binding and Projection digests, Installation ID and digest,
selected expected and actual Program and contract digests, the full
`installationProgramDigest`, interaction ID, and request Realization ID. Control MUST combine those pins with the execution Realization
ID, packaged control realization digest, and static control digest in the exact
`ControlTarget`; its `programDigest` MUST identify the full installation Program,
while `expectedProgramDigest` and `actualProgramDigest` identify the selected
Programs. Every durable Control record MUST repeat that target identity.

Private input, baseline, and state MUST remain journal-private. Public proposals
MUST contain only host-designated public subject, baseline summary, effects, and
preview.

## Durable records version 1

Proposal, approval, grant, attempt, and receipt records MUST use version 1 and
pin the full actual `installationId`, `installationDigest`, Program and contract
identity, request and execution Realization IDs as applicable, control digest,
actor, and phase identities. `bindingDigest` MAY remain as origin correlation;
durable execution authority MUST NOT depend on continued Binding liveness.

Proposal identity MUST use `boundary.control-proposal/v1`. Version 1 is the only
Control record format. Unknown or future versions MUST be rejected.

Approval, grant, and execution MUST recompute proposal integrity. `approve`
MUST create no grant or attempt. `grant` MUST create no attempt. A redeployed
Installation MUST NOT execute an old grant by matching only interaction ID or
structurally compatible contract.

Caller context MUST be supplied explicitly to execute and reconcile, reach
native hooks by exact reference, and remain absent from every durable record.

## Attempt and lease law

Grant integrity, expiration, policy, and preflight MUST be checked before an
attempt exists. An attempt MUST be persisted before `apply` begins. Its lease
MUST use journal compare-and-swap, expiry, renewal, and a monotonically
increasing fencing token, and MUST be rechecked immediately before `apply`.

An active lease MUST NOT be reconciled. An expired active attempt MUST become
uncertain before reconciliation. Recovery MAY inspect reality but MUST NOT call
`apply`.

## Outcomes

```ts
type EffectResult<T> =
  | { status: "completed"; value: T; receipt: Receipt }
  | { status: "uncertain"; attempt: AttemptRef<T> }
  | { status: "not-applied"; reason: string };
```

`uncertain` is the durable form of an invocation's `unknown` certainty: the
same fact, persisted with an attempt reference so it can be reconciled.

`AttemptRef<T>` preserves the output relation in the native TypeScript API only.
That phantom relation is absent from durable records and wire schemas; decoded
references and string IDs retain `unknown`. Rust's native Control output
behavior is unchanged. The relation grants no authority and does not replace
runtime identity or output validation.

After an attempt exists, failures in `apply`, output validation, verification,
clock, lease, or journal persistence MUST remain uncertain unless durable
evidence proves completion or non-application.

Completion requires validated output, verifier success, and a persisted
receipt. A completed replay MUST return the original value and receipt without
calling `apply`. Reconciliation MAY return completed, not applied, or continued
uncertainty and MUST never perform the effect.
