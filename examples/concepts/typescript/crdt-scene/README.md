# Experimental CRDT scene snapshots

This example exercises Boundary's **experimental** Yjs and Automerge adapters.
Their APIs may change incompatibly and have no production support commitment.
Passing this example does not establish production readiness. See
[integration status](../../../../docs/concepts/current-status.md#experimental-integrations).

Run the reusable examples from the workspace:

```sh
pnpm exec tsx examples/concepts/typescript/crdt-scene/run.ts
```

The packed-consumer process proof builds the SDK, installs optional engine
peers in an isolated temporary consumer, typechecks these same sources, and
runs them against the packed package:

```sh
just crdt-e2e
```

Each example creates two native replicas, makes disjoint edits, exchanges real
Yjs updates or Automerge Sync messages, and passes immutable captures through
the same host-owned `createHost` journey. The accepted candidate survives
later live edits and deletion, and its engine bytes and host metadata reload
with the same content digest. Unit tests inject in-process delivery while
retaining the native engine messages; the executable and packed-consumer paths
use a private loopback TCP relay between replicas in one process.

The relay has no authenticated principal. This example does not establish
authorization of arbitrary inbound CRDT updates, cross-process collaboration,
browser behavior, cross-engine parity, or crash/power-loss durability. The
host owns admission, resource and generation identity, acceptance baseline,
content validation, digest, and candidate acceptance; engine snapshot markers
are not authorization or acceptance decisions.
