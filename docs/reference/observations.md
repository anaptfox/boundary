---
title: "Observed reads"
description: "Reuse host computations after validating their captured point and query evidence."
---

# Observed reads

Import `observedRead` from `@foxworth/boundary/observations`. This optional native
implementation adapter records actual point and query observations and can
reuse a completed result after the host validates them against a new immutable
snapshot. It realizes an authentic interaction whose `changes` list is empty.
It adds no caller methods, portable declaration fields, or execution authority.

## Author a read

```ts
import { implementInteractions } from "@foxworth/boundary";
import { observedRead } from "@foxworth/boundary/observations";

type Context = Readonly<{ workspace: string; principal: string }>;
const implementations = implementInteractions<typeof interactions, Context>(interactions, {
  get: observedRead(interactions.get, {
    snapshots: documentSnapshots,
    scope: context => ({ workspace: context.workspace, principal: context.principal }),
    authorize: (input, context) => assertCanRead(context, input.id),
    async evaluate(input, view) {
      const document = await view.read(input.id);
      if (document.kind === "absent") throw new Error("document not found");
      return document.value;
    },
    reuse: "validated",
  }),
});
```

Install this implementation using the usual `installInteractions`, with an
explicit direct Realization ID. Ordinary Binding admission and `caller.call`
remain unchanged. The helper has no cache until installed; calling the inert
implementation directly fails. A helper from another definition or package
instance cannot bypass authentic definition ownership.

## Snapshot adapter contract

The host implements `ObservationSource<Context, Key, Point, Query, Rows>`:

```ts
withSnapshot(context, scope, run): Promise<Result>
```

Acquire one immutable snapshot or transaction, invoke `run(snapshot)` exactly
once, keep that snapshot consistent until its returned promise settles, and
return its exact successful result. Acquisition, callback, or completion failure
must reject. The library rejects missing, repeated, abandoned, or altered
callback results and retains no newly computed result from a failed source.

The snapshot implements these methods:

| Method | Result and obligation |
| --- | --- |
| `read(key)` | `{ kind: "present", value, token }` or `{ kind: "absent", token }`. Evidence must cover both presence and content; present `null` is distinct from absence. |
| `query(descriptor)` | `{ value, token }`. The descriptor supplies the complete filter, ordering, and pagination. The token must cover the complete answer, including newly matching records and inserts that shift a page. |
| `validate(observation)` | `"matching"`, `"changed"`, or `"unavailable"`, using that same immutable snapshot. |

The evaluation view exposes `read(key)` without its token and `query(descriptor)`
as the query value. It owns copies of keys, descriptors, values, and tokens.
TypeScript requires JSON data for those values and the visibility scope. An
observation view closes when evaluation ends and must not escape that lifetime.

The Todo example's [snapshot adapter](../../examples/apps/typescript/todo-multisurface/observations.ts)
uses answer-content tokens as a correct baseline. Computing those tokens can
itself require the full query. A database adapter can supply cheaper authoritative
versions if they establish the same evidence. Reuse counters alone are not a
runtime speed claim.

## Authorization, identity, and retention

Binding admission runs afresh before execution. `authorize(input, context)` runs
afresh before both evaluation and reuse. The host-owned `scope(context)` must
identify every visibility distinction affecting the answer. Scope is data, not
authorization; a newly restricted principal still requires fresh admission and
authorization.

Each installation gets a separate cache tied to its authentic definition,
compiled contract, and direct realization. Entries additionally key exact input
and scope. Changing an installation or realization cannot reuse another cache.
The host must issue fresh realization identity when executable behavior changes.

Reuse defaults to `"off"`. `"validated"` enables retention, with a FIFO bound of
128 entries unless `maxEntries` is supplied. Zero disables retention. Every
captured observation must validate as matching before returning the retained
value, inside the same snapshot callback. Changed, unavailable, thrown, or
invalid validation causes fresh evaluation.

Retain only successful schema-valid outputs from a completed source callback and
a complete settled capture. Read failures remain sticky even when evaluation
catches them; outstanding reads and closed-view failures prevent retention.
Results returned to callers are isolated copies. Installation revocation clears
and closes its caches. This helper does not cache writes or justify repeating
an uncertain effect.

## Evidence and diagnostics

Evidence is private host state. It does not change Program, Surface, or
Binding digests, nor the existing invocation observation envelope, HTTP
observation stream, or coarse client invalidation behavior.

Optional `diagnostic(event)` reports `reused`, `validations`, `observations`, and
the reason: `reuse-off`, `miss`, `matching`, `changed`, or `unavailable`.
Diagnostic failures cannot change invocation truth. Use these counters to compare
validated reuse with fresh evaluation; include validation and token-production
work in any performance measurement.

The host owns evidence completeness, snapshot consistency, and evaluator purity.
The library cannot prove that arbitrary application code avoided ambient reads
or that a dishonest validator is correct. Test adapters against fresh evaluation,
especially missing-to-present changes and query membership, ordering, and page
boundaries. The [Rust reference](./rust.md#native-observed-reads) describes the
independent native API, which preserves native keys, tokens, scope, and outputs.
