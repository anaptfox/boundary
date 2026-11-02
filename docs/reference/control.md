---
title: "Control reference"
description: "Durable authority and recovery when a returned function is not enough evidence."
---

# Control reference

`@foxworth/boundary/control` is the optional durable authority and recovery module for
interactions where “the function returned” is not enough evidence. It separates
proposal creation, review, grant, the first possible effect, verification, and
reconciliation while preserving the target interaction and Installation
identities.

Control is not part of the direct `@foxworth/boundary` root. Control itself depends
on `@foxworth/boundary/program` only; Host is an optional peer of the
`@foxworth/boundary/control/host` bridge. The bridge alone consumes the narrow
`@foxworth/boundary/host/control` contribution seam; application and adapter authors
should not construct request contributions through that lower-level subpath.
That support export is not a same-process security boundary: JavaScript cannot
authenticate the package that called an exported function. Code that calls it
directly is part of the application Host's trusted computing base. Its opaque
artifact prevents accidental structural forgery and post-construction identity
drift; only the higher-level Control bridge constrains the capability to an
authentic `ControlRequester`.
Requester authenticity is scoped to one loaded `@foxworth/boundary/control` module
instance. Accidentally mixing duplicate package instances fails closed; Boundary
does not use a process-global registry that unrelated code could mutate.

## Capabilities are split by authority

Control exposes three deliberately different interfaces:

```ts
interface ControlReader {
  get(reference: ControlRecordRef): Promise<ControlRecord | undefined>;
  status(reference: ControlStatusRef): Promise<ControlStatus>;
  list(query?: ControlListQuery): Promise<readonly ControlRecordSummary[]>;
  page(query: ControlPageQuery): Promise<ControlPage>;
}

interface ControlAdmin<Actor, Context> {
  approve(proposal: ProposalRef, actor: Actor): Promise<Approval>;
  grant(proposal: ProposalRef, actor: Actor): Promise<Grant>;
  execute(
    grant: GrantRef,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult>;
  reconcile<Value extends AttemptRef>(
    attempt: Value,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult<AttemptOutput<Value>>>;
  reconcile(
    attempt: UntypedAttemptRef | string,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult>;
}
```

- `ControlReader` has observation authority only: `get`, `status`, and `list`.
- `ControlAdmin` owns approval, grant, execution, and reconciliation. It does
  not implicitly include the Reader; a host may supply both capabilities to an
  operator that needs both.
- `caller.request` creates a proposal only. It is not a Reader or Admin method.

No one capability is a convenience facade for the others. A caller, transport,
agent tool, or possession of a public proposal cannot approve, grant, execute,
or reconcile.

### Reader scope is mandatory

A Reader is created with an explicit observation scope:

```ts
import { createControlReader } from "@foxworth/boundary/control";

const reader = createControlReader(
  { journal },
  {
    interactionIds: ["documents.replace"],
    tenant: { kind: "workspace", id: "workspace-42" },
  },
);
```

`tenant` is a host-chosen scope identity represented by the proposal subject;
Control does not infer it from caller input, ambient context, or a query. The
scope must contain at least one valid interaction ID and one exact tenant subject.
Control snapshots, canonicalizes, and freezes the scope when the Reader is
created, so later mutation of the caller-owned array or subject cannot widen
observation authority.

Every `get`, `status`, and `list` interaction requires both the proposal's exact
interaction ID and exact subject to match the captured scope. Out-of-scope data is
indistinguishable from absence: `get` returns `undefined`, `status` reports the
same unknown-proposal diagnostic as a missing ID, and `list` omits the record.
Filters can narrow a list but cannot broaden the captured scope. The Reader
applies the same check to approvals, grants, attempts, and receipts by following
their exact proposal identity.

`createControlCapabilities(options, host, readerScope)` and
`installControlPart(part, host, readerScope)` require the same scope for their
Reader capability. The scope does not attenuate or silently add Admin authority;
`ControlAdmin` remains a separate capability supplied deliberately by the host.

## Request bridge — `@foxworth/boundary/control/host`

`contributeControlRequests` contributes exact request-mode realizations to an
`InteractionInstallation`. Each contribution names one interaction, one request
`RealizationId`, one control digest, and one public-preview schema.

The bridge has exactly create-proposal authority. A request proceeds in this
order:

```text
validate Binding and input
        -> Binding admission
        -> plan against current host reality
        -> validate private state and public preview
        -> Control request policy
        -> persist exact proposal
        -> return public proposal
```

Denial and faults are distinct. Binding admission denial happens before plan.
Control policy denial happens after a valid plan but before persistence. A
planning, validation, journal, or integrity failure is a fault, not a denial.

Planning MUST NOT perform the target effect. This is a Host realization
obligation: neither TypeScript nor an in-process package boundary can prove an
arbitrary planning hook effect-free. The bridge itself cannot approve, grant,
create an attempt, execute, verify, reconcile, or retry. With an honest
Host-supplied plan, a successful request outcome has Handoff certainty
`not-started` for the target interaction. Untrusted plan providers require a
Host-chosen isolation boundary rather than this same-process bridge.

Request is a mode on the original host-authored interaction. It is not a synthetic
Control-prefixed interaction, renamed copy, tool-only interaction, or workflow-owned
identity. Changing the target contract is an ordinary versioned contract break.

## Controlled realization

Administrative execution resolves the exact actual interaction and Installation
pinned by the proposal. Its host-owned realization supplies:

- `plan`: derive subject, baseline, declared effects, private state, and public
  preview from current reality;
- `apply`: perform the reviewed effect while holding the attempt lease;
- `verify`: check returned output against host-selected evidence; and
- `reconcile`: inspect reality after uncertainty without rerunning `apply`.

The host also supplies an artifact-backed realization digest. Boundary never hashes
function source text. `boundary.control-realization/v1` hashes exactly
`interactionId`, `interactionContractDigest`, `realizationDigest`, `stateSchema`,
and `previewSchema`. Installation and final runtime identity are deliberately
absent: the Installation digest already contains the Catalog's control digest,
so including it would create an identity cycle.

After admission, Host supplies a frozen `RequestInvocationPolicy` carrying
request mode, Binding and Surface digests, Installation ID and digest,
expected and actual Program and contract digests, interaction ID, and request
Realization ID. Control combines those pins with the execution Realization ID,
packaged control realization digest, and static control digest in the exact
`ControlTarget`. Proposal, approval, grant, attempt, and receipt records repeat
that target identity.

Private input, baseline, and state remain in journal-private records. Public
proposals contain only host-designated subject, baseline summary, effects, and
preview. Secrets do not belong in public fields.

## Lifecycle

```text
request -> approve -> grant -> attempt -> apply -> verify -> receipt
                                      |
                                   uncertain -> reconcile
```

- Request validates, plans, evaluates request policy, persists, and returns one
  exact proposal.
- Approve records a review decision but creates no grant or attempt.
- Grant records permission to execute one exact proposal but creates no
  attempt.
- Execute persists an attempt before `apply`, then verifies and persists a
  receipt.
- Reconcile classifies an inactive uncertain attempt by inspecting reality and
  never reruns `apply`.

## Durable record identity version 1

Every proposal, approval, grant, attempt, and receipt is a version 1 record. It
pins:

- `installationId` and `installationDigest`;
- actual Program and interaction-contract identity;
- exact request and, once selected, execution `RealizationId`;
- control realization digest;
- proposal, grant, attempt, and receipt identity appropriate to that phase; and
- actor and time evidence supplied by host policy and clock.

Records may retain `bindingDigest` as origin correlation, but the durable
execution authority is the full actual Installation and realization identity,
not continued liveness of the caller Binding. A redeployed Installation cannot
execute an old grant by matching only interaction ID or contract shape.

Proposal identity uses `boundary.control-proposal/v1`; controlled realization
identity uses `boundary.control-realization/v1`. Version 1 is the only Control record
format. Unknown or future versions are rejected.

Approval, grant, and execution recompute proposal integrity. A journal's create
or compare-and-swap response must be canonically identical to the exact record
candidate supplied by Control, including actor and timestamp.

Caller context is supplied explicitly to administrative execute and reconcile,
reaches native hooks by exact reference, and is never persisted in Control
records.

## Attempts, leases, and outcomes

Grant integrity, expiration, policy, and preflight are checked before an
attempt exists. An attempt is durably persisted before `apply` begins. Its lease
uses compare-and-swap, expiry, renewal, and a monotonically increasing fencing
token, and is rechecked immediately before `apply`.

```ts
type EffectResult<T> =
  | { status: "completed"; value: T; receipt: Receipt }
  | { status: "not-applied"; reason: string }
  | { status: "uncertain"; attempt: AttemptRef<T> };
```

Once an effect may have started, an apply, output-validation, verification,
clock, lease, or journal failure remains `uncertain` unless durable evidence
already proves completion or non-application. A missing response is not proof
that nothing happened.

Completion requires returned output, successful output validation, verifier
success, and a persisted receipt. A completed replay returns the original value
and receipt without calling `apply`. An active lease cannot be reconciled. An
expired active attempt becomes uncertain before reconciliation. Reconciliation
may return completed, not applied, or continued uncertainty and must never call
`apply`.

### Native TypeScript recovery inference

An uncertain `EffectResult<Output>` carries an `AttemptRef<Output>`. Reconciliation
infers the completed value from that reference and preserves the relation if the
result remains uncertain:

```ts
const result = await admin.execute(grant, executor, context);
if (result.status === "uncertain") {
  const recovered = await admin.reconcile(result.attempt, executor, context);
  if (recovered.status === "completed") {
    useOutput(recovered.value); // Same output type as execute(grant).
  }
}
```

`AttemptOutput<Value>` extracts the output relation from a typed reference.
Callers cannot supply an arbitrary output type to `reconcile`; they must retain
the reference obtained from typed execution or recovery. An attempt ID, Reader
record, or `publicAttempt(durableRecord)` carries `unknown`, because durable
records contain no TypeScript output evidence.

`AttemptRef<Output>` requires a private phantom marker minted by Control. A
durable record or reconstructed plain identity cannot be assigned that type.
`UntypedAttemptRef` accepts structural identities for recovery with `unknown`
output; `publicAttempt` validates and mints only an unknown-output reference.

This is a native TypeScript inference capability. The phantom relation is absent
at runtime, changes no durable record or wire schema, and grants no authority.
Reconciliation still checks exact target identity, current realization, policy,
leases, fencing, and validated output. Rust retains its existing native Control
output behavior; this addition makes no new cross-language typing claim.

## Test adapters

`MemoryJournal`, `TestClock`, and `TestIds` from
`@foxworth/boundary/control/testing` are deterministic test adapters. `MemoryJournal`
is process-local; production recovery requires a host-owned durable journal.

Continue with [Host](./host.md), [Handoff](./handoff.md), and the
[normative Control laws](../spec/03-control-and-recovery.md).

## Narrow request surfaces

The TypeScript Host bridge distinguishes the selected expected Program,
selected actual Program, and full installation Program. Request policy includes
`installationProgramDigest`; proposals and their approval/grant/attempt/receipt
identity chains pin `expectedProgramDigest`, `actualProgramDigest`, and the full
installation `programDigest` separately. A caller selecting one request interaction
can propose against a larger installation without receiving its other interactions.
This bridge identity is separate from Rust's native Control interaction references.

## Bounded native reader queries

TypeScript readers expose `reader.page({ limit, afterId?, interactionId? })` for
host journals implementing `queryProposals` and `readStatusChains`. `limit` is
1–100. Results contain `items` and an optional `nextAfterId`; pass that value as
`afterId` for the next page. This is a native TypeScript storage capability, not
a new portable Control interaction or a Rust storage API.

Control requests at most `limit + 1` proposals and one batch of status chains.
It checks scope, proposal integrity, strict UTF-8 ID ordering, page bounds, batch
keys, and the complete grant/attempt/receipt relationships before exposing public
records. Database filtering never grants observation authority. An adapter
returning an out-of-scope row fails the page. Malformed in-scope rows in the
requested page fail validation; unrelated pages are not inspected.

Cursors are exclusive IDs, not snapshot tokens. Inserts behind a cursor require
a fresh traversal; concurrent updates can change statuses across pages. Journals
without both methods reject `page` instead of silently scanning. Existing
`list({ proposalId })` uses a direct lookup; unrestricted `list()` still collects
all rows, with at most sixteen status chains in flight.

## Durable journal example and evidence

The host-owned [SQLite example](../../examples/concepts/typescript/control-durable/README.md)
uses Node's built-in SQLite module, transactional uniqueness and CAS, and SQL
scope/page/batch queries. Its document mutation checks the persisted lease's
owner, fence, expiry and execution state inside the same database transaction as
the effect and its proposal-keyed ledger entry. Reconciliation reads that exact
ledger, so another writer cannot turn matching content into completion evidence
or erase a completed effect by overwriting the document. A journal fence alone
cannot protect an external effect.

A factory-driven journal qualification suite runs identical laws against
MemoryJournal and SQLite, including reopen, uniqueness, immutable fields, stale
CAS, pagination and public redaction. Actual child-process SIGKILL tests stop
after attempt persistence, after the document mutation, and after receipt commit.
Fresh connections recover without a second application. A suspended executor
cannot mutate after another connection takes over reconciliation.

Two reviewed [recovery traces](../../tests/conformance/v1/control-recovery.json)
are consumed independently by TypeScript and Rust: completed replay and lost
acknowledgment followed by reconciliation. They establish those lifecycle laws,
not wire-record compatibility or native durable-storage parity. SQLite evidence
covers process death on the local filesystem; it does not establish power-loss,
network-filesystem, replicated-storage or production deployment guarantees.
