# `@foxworth/boundary/http`

Transport-neutral Surface clients plus HTTP, OpenAPI, protocol, and
resolution helpers. `@foxworth/boundary/client` also supplies the
framework-neutral `watchInteraction` read store and explicit footprint
invalidation. Framework HTTP mounts live at
`@foxworth/boundary/frameworks/hono`, `@foxworth/boundary/frameworks/next`, and
`@foxworth/boundary/frameworks/vite`. The optional tRPC adapter is available only
from `@foxworth/boundary/frameworks/trpc`.

The package root does not load tRPC, Hono, or Vite. Those subpaths require
their optional peer dependencies.

## Local CRDT snapshots

**Status: experimental.** The snapshot adapters are for evaluation, may change
incompatibly, and have no production support commitment. See the
[integration status](../../docs/concepts/current-status.md#experimental-integrations).

`@foxworth/boundary/yjs` and `@foxworth/boundary/automerge` are optional
snapshot helpers. Each captures the current document version synchronously,
returns copied encoded bytes and an engine-specific version marker, and can
project portable JSON from a fresh materialized document. A read awaits an
asynchronous projector before releasing that temporary document.

These subpaths do not synchronize replicas, persist snapshots, assign
application candidate IDs, or make policy decisions. Hosts own those choices.
The Yjs helper rejects attached subdocuments because a parent update contains
their references rather than their contents. See the
[snapshot guide](../../docs/guides/crdt-snapshots.md) and
[adapter reference](../../docs/reference/adapters.md#read-only-crdt-snapshots).
