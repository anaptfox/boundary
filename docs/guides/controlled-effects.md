---
title: "Controlled effects"
description: "Separate a proposal from execution when a returned function is not enough evidence."
---

# Controlled effects

Use Control when “the function returned” is not enough evidence about what
happened. Money movement, publication, deployment, deletion, and external APIs
are common examples. Keep ordinary interactions on the direct path.

> **Status:** The `@foxworth/boundary/control` foundation and its
> `@foxworth/boundary/control/host` bridge are current workspace interfaces. Both remain
> pre-release and unpublished.

## Select propose before a deployment realizes it

A Surface can select `propose` for an interaction before any Installation
contributes a proposal path:

```ts
const operatorSurface = surface(docs, { call: ["status"], propose: ["publish"] });
```

The Control-owned bridge contributes an opaque, exact request capability. On
the short path it is the `requests` option of `install`, a function of the
compilation so the bridge can pin the compiled handle:

```ts
import { contributeControlRequests } from "@foxworth/boundary/control/host";

const app = await install(docs, {
  id: "docs:prod:7",
  version: "publish-3",
  handlers,
  requests: (compiled) => contributeControlRequests(compiled, controlRequester, {
    publish: {
      interaction: compiled.handles.publish,
      control: publishControl,
      executionRealizationId: publishExecutionRealizationId,
      actor: (context) => context.actor,
    },
  }),
});
```

The bridge owns proposal creation only. It cannot approve, grant, apply,
execute, verify, or reconcile. Without the request capability, `connect`
refuses the Surface with `missing-request`; the `fix` text says to contribute a
Control request or move the alias from `propose` to `call`. The host retains
`app.revoke`; adapters receive only the caller.

After a successful connect, a proposal is one method call that visibly differs
from a call:

```ts
const operator = await app.connect(operatorSurface, { admit });
const proposal = await operator.propose.publish({ releaseId }, actor);
```

Request ordering is fixed:

```text
validate -> admission -> plan -> Control request policy -> persist proposal
```

A proposal never performs the effect. Direct-only hosts do not import Control
and their callers have no `propose` methods. On the explicit pipeline the same
contribution is `installInteractions(compiled, { requests, realizationIds })`
with a `request` realization id per proposing alias
(`realizationIdsFor(compiled, version, { request: ["publish"] })`).

## See the failure problem

```text
apply starts -> external system changes -> connection disappears
                                      |
                         did it happen or not?
```

Reporting failure may invite duplication. Reporting success invents evidence.
Blind retry can be worse than either. Control adds an honest third state:

```text
request -> approve -> grant -> attempt -> apply -> verify -> receipt
                                      |
                                   uncertain -> reconcile
```

## Supply four application hooks

The Control foundation resolves an exact interaction target to:

- `plan`: derive subject, baseline, declared effects, private state, and public
  preview without performing the effect;
- `apply`: perform reviewed work while holding the attempt lease;
- `verify`: decide whether configured application evidence supports completion;
- `reconcile`: inspect reality after uncertainty without rerunning `apply`.

The host supplies private-state and public-preview schemas plus a
`realizationDigest` from the packaged executable artifact. Control binds these
to the interaction contract as `controlDigest`; it never hashes function source.

Keep raw input, baselines, and recovery state private. Only author-designated
subjects, summaries, effects, and previews cross a review seam.

## Keep observation and administration separate

The accepted Control foundation exposes deliberately separate capabilities:

```ts
const reader: ControlReader = controlReader;
const admin: ControlAdmin<Actor, ExecutionContext> = controlAdmin;
```

`ControlReader` can inspect records and status but cannot approve, grant,
execute, or reconcile. `ControlAdmin` owns those authority phases and does not
implicitly include observation. The request-capable Caller has neither Reader
nor Admin authority.

The application supplies the durable journal, policy, clock, executor identity,
lease behavior, validators, and hooks behind those capabilities. A production
journal needs atomic record creation and compare-and-swap for attempts. The
in-memory testing journal is not durable storage.

## Keep authority phases separate

```ts
const proposal = await operator.propose.publish({ body: "after review" }, actor);

await admin.approve(proposal, reviewer);
const grant = await admin.grant(proposal, owner);
const result = await admin.execute(grant, executor, executionContext);
```

`propose` plans and persists. `approve` records review. `grant` records
execution authority. `execute` persists or replays an attempt, applies at most
once, verifies, and records a receipt.

Context is always fresh and ephemeral. Request context reaches planning;
execution context reaches apply and verify. Context is never serialized into a
proposal, approval, grant, attempt, or receipt.

### Delegation is not a grant

An application may let an agent edit drafts within a delegated workspace while
requiring review to publish. That task-level permission is host policy, not an
exact grant for every consequence. Keep executor and delegator distinct when
constructing trusted context.

One "Approve and publish" button may invoke an authorized server path that
records approval, issues the exact grant and executes it. The UI gesture does
not merge those authority phases or expose `ControlAdmin` to the client.
Proposals and review status should expose only the public data designated by
the host. The same rules apply when the original requester is human.

See [humans and agents](./humans-and-agents.md) for the distinction between
interaction interactions, application tasks and optional world semantics.

## Handle all three durable outcomes

```ts
switch (result.status) {
  case "completed":
    return result.value;
  case "not-applied":
    return explain(result.reason);
  case "uncertain":
    return queueReconciliation(result.attempt);
}
```

`completed` is bounded evidence: apply returned, output validation passed,
verification passed, and a receipt persisted. `uncertain` means the effect may
have started. Never rewrite it as failure or retry it blindly.

Once the attempt lease is inactive, `admin.reconcile` may establish
`completed`, `not-applied`, or continued `uncertain`; it never invokes `apply`.

Retain the typed attempt when scheduling recovery:

```ts
if (result.status === "uncertain") {
  const recovered = await admin.reconcile(
    result.attempt,
    executor,
    executionContext,
  );
  if (recovered.status === "completed") return recovered.value;
}
```

In TypeScript, `AttemptRef<Output>` preserves the output type from the grant
through repeated uncertain results. Reconciliation infers that type; it does not
accept a caller-selected output type. Persisting only an ID or decoding a public
record loses this native relation, so recovery returns `unknown` until application
code validates the output. Durable formats and Rust's native Control behavior
are unchanged.

Read the [Control foundation reference](../reference/control.md) for the current
record formats and lifecycle laws.
