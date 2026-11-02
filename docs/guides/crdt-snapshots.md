---
title: "Experimental CRDT snapshots"
description: "Evaluate Boundary's experimental Yjs and Automerge snapshot adapters and their current limits."
---

# Experimental CRDT snapshots

**Status: experimental.** Boundary's Yjs and Automerge adapters are available
for evaluation. Their APIs may change incompatibly and carry no production
support commitment. Pin the exact package snapshot when trying them. This
status applies to Boundary's adapters, not to Yjs or Automerge themselves.
See [availability and support](../concepts/current-status.md#experimental-integrations).

Import these adapters through `/yjs` or `/automerge`.

Boundary has optional TypeScript subpaths for reading one captured version of a
Yjs or Automerge document. Capture is synchronous. Each later `read(project)`
materializes an isolated document from the captured bytes, awaits the projector,
and returns normalized portable JSON. The temporary document is released after
the projector settles, including when it throws. Encoded bytes are copied at
capture and again when returned.

```ts
import * as Y from "yjs";
import { captureYjs } from "@foxworth/boundary/yjs";

const liveDoc = new Y.Doc();
const position = liveDoc.getMap<number>("position");
position.set("x", 12);
position.set("y", 20);

const captured = captureYjs(liveDoc);
await captured.read((snapshot) => {
  const position = snapshot.getMap<number>("position");
  return { x: position.get("x") ?? 0, y: position.get("y") ?? 0 };
});
```

For a richer two-replica workflow, see the runnable
[scene example](../../examples/concepts/typescript/crdt-scene/).

The projector must return JSON data, not an engine proxy or class instance.
Boundary normalizes and freezes the returned projection. A projector can mutate
its temporary document without changing the original or a later read of the
capture. An asynchronous projector keeps its own temporary document until its
promise settles.

## Yjs — `@foxworth/boundary/yjs`

`captureYjs(doc)` returns `{ engine: "yjs", frontier, encode, read }`.
`frontier` is lowercase hexadecimal for `Y.encodeSnapshot(Y.snapshot(doc))`.
It encodes the Yjs snapshot's state vector and delete set. It is a version
marker, not a content hash, durable receipt, or authority token. In particular,
a deletion can change the marker even when the state vector does not. `encode()`
returns a copy of a full-state Yjs update suitable for applying to another
document.

Yjs subdocuments are rejected at capture. A parent update can retain references
to subdocuments without containing their document contents, so treating that
update as a complete snapshot would be misleading. This helper also does not
capture `Y.Doc` configuration or local metadata such as client identity,
garbage-collection settings, or provider/awareness state. Include any
application-relevant metadata in the host's own schema and storage.

## Automerge — `@foxworth/boundary/automerge`

`captureAutomerge(doc)` returns `{ engine: "automerge", heads, encode, read }`.
It clones the supplied document handle first, then records a frozen copy of the
clone's `Automerge.getHeads` and copied `Automerge.save` bytes. This keeps the
encoded state and heads aligned with the version represented by the supplied
handle, including when it is a historical `Automerge.view` or retained older
document handle. Each read loads a new document from those captured bytes,
awaits the projection, validates its JSON output, and releases the loaded
document.
Project a plain object rather than returning an Automerge proxy directly,
since the proxy can expose engine metadata that is outside portable JSON.

```ts
import * as Automerge from "@automerge/automerge";
import { captureAutomerge } from "@foxworth/boundary/automerge";

const liveDoc = Automerge.from({ items: [{ id: "orb", x: 12, y: 20 }] });
const captured = captureAutomerge(liveDoc);
await captured.read((snapshot) => ({
  items: snapshot.items.map((item) => ({
    id: item.id,
    x: item.x,
    y: item.y,
  })),
}));
```

Neither version marker proves authorship, acceptance, freshness against a live
document, or application validity. The host owns identity, schemas, policy,
candidate IDs, candidate storage, and decisions to accept or persist a
projection.

## Synchronization and storage stay with the host

These subpaths do not mutate a live document, exchange updates, choose a
provider, authenticate peers, or persist data. They contain no network or
browser synchronization layer. The host chooses when to capture, how to retain
the bytes, how replicas exchange updates, and which candidate can be shown or
accepted. This keeps a captured version separate from a decision about that
version.

The executable [CRDT scene example](../../examples/concepts/typescript/crdt-scene/)
uses native Yjs and Automerge documents, an application-owned candidate store,
and a short-lived loopback relay to exercise replicas. Run it from the
repository root with `pnpm exec tsx examples/concepts/typescript/crdt-scene/run.ts`.
The built-package process proof is `just crdt-e2e`; its relay is local to that
test. These examples establish only their exercised in-process and loopback
paths, not a production provider, browser integration, or durable multi-user
service.

The example keeps snapshot capture separate from acceptance. A later edit to
the live scene does not by itself stale a candidate. Accepting another
candidate advances the host-owned accepted baseline, so other candidates tied
to the older baseline then become stale.

For the underlying engine behavior, see the official
[Yjs document updates guide](https://docs.yjs.dev/api/document-updates),
[Yjs snapshot API](https://github.com/yjs/yjs/blob/v13.6.33/src/utils/Snapshot.js),
[Yjs subdocument guide](https://docs.yjs.dev/api/subdocuments), and Automerge's
[save](https://automerge.org/automerge/api-docs/js/functions/save.html),
[load](https://automerge.org/automerge/api-docs/js/functions/load.html),
[free](https://automerge.org/automerge/api-docs/js/functions/free.html), and
[getHeads](https://automerge.org/automerge/api-docs/js/functions/getHeads.html)
API references.
