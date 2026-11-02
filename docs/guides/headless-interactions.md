---
title: "Headless interactions"
description: "Local interaction state for projected interactions, without owning the renderer or store."
---

# Headless interactions

Boundary supplies local interaction state, not a renderer or an application store.
The host still owns identity, authorization, lifecycle, persistence, and the
meaning of an interaction. A projected handle selects a declared interaction; it
does not authorize it.

Use an explicit interaction for buttons, forms, menus, and agent-driven UI
actions. Creation is inert: it sends no request. Call `invoke` only from the
application event that intends the interaction.

The checked non-React proof is
[`interaction.test.ts`](../../tests/typescript/interaction.test.ts). It creates
an interaction, verifies that creation performs no call, and invokes it only
from the test's explicit action.

The snapshot is client-local. Its `phase` records the latest invocation as
`pending`, `succeeded`, `failed`, or `uncertain`; `availability` separately says
whether this store is `available`, `stale`, `disconnected`, or `disposed`.
Neither field is an authoritative host lifecycle record. `result` is the latest
successful returned value; declared errors and sanitized transport errors are
in `error`. A remote error with `certainty: "unknown"` means the invocation may
have started, including a server execution fault as well as a lost response.
Do not retry it automatically; reconcile through an application-owned,
authorized path.

## Proposals and public status

Request mode creates a proposal. It does not approve, grant, execute, or
refresh reads. Keep Control administration on the host. To show a status card,
pass only a host-issued public observation function—not a journal, raw record,
or admin capability—and observe the returned proposal explicitly.

The checked proposal/status separation is in
[`interaction.test.ts`](../../tests/typescript/interaction.test.ts).

The function is application wiring, not a proof of authorization or redaction.
The host must derive it from the current authenticated request/session and a
narrow `ControlReaderScope`. Never transfer a reader, tenant selector, admin
capability, or raw Control record to a browser client.

## React

`useInvocationState` and `useProposalInteraction` adapt the same stores;
they do not create another query cache or render components. Both hooks are
inert on mount. The application calls `invoke`/`request` and `observe` from its
own UI events.

The checked React path, including StrictMode, is in
[`react-interaction.test.tsx`](../../tests/typescript/react-interaction.test.tsx).

Direct successful changes use the existing explicit cache scope to refresh
affected mounted reads. A proposal never implies a completed change, so it does
not invalidate reads.

## Replacement and recovery

Call `markStale()` when the host reports that the pinned binding is no longer
current, and `disconnect()` when the application loses its approved transport.
Both change `availability` and block later invocation and proposal observation.
They clear proposal status and suppress late public status reads, but preserve
existing invocation evidence. The same status retirement occurs when the
application calls these methods, or `dispose()`, directly on a proposal
interaction's exposed `invocation`; status subscribers receive the cleared
snapshot, including when a public status read was still pending. A pending invocation can still settle on its
original store: a late result remains `succeeded`, and a lost outcome becomes
`uncertain`, while the store stays unavailable. Before any invocation, `phase`
may also show the unavailable status.

Dispose the interaction when its screen or host lifetime ends. Disposal removes
listeners and blocks invocation; its readable snapshot retains existing attempt
evidence and can still record that attempt's late outcome. It does not cancel
execution. Preserve unresolved attempt information for the application's
reconciliation UI. To reconnect, obtain a newly authorized client from the host
and create a new interaction; the replacement cannot reuse the old invocation
or grant. `describeInteractionError` reports trusted unknown execution faults
with reconciliation guidance instead of presenting them as a definite failure.

`useInteraction` uses the same interaction store for mutations. Both reject a
second invocation while one is in flight. A successful mutation becomes
successful when its result arrives; dependent read refresh runs separately,
and a failed or slow refresh cannot turn that mutation into a failure.
Changing a client or handle retires the previous view. Calls queued before
inspection reject if that view unmounts; retired callbacks cannot dispatch
through a replacement client.
