# Process tests

These are tests that spawn a real build or runtime. They are not fixtures
and they are not Vitest files.

`pnpm test` stays in-process. A missing Next, Bun, workerd, or Electron
must stay blocked, never a skipped-green unit test. `justfile` recipes run
these at the ladder tier that owns that evidence.

Fixtures consumed here live under `tests/fixtures/`.

`just release-test` runs the release subprocess, crash, and journal tests plus
the installed npm against a synthetic localhost registry. It is part of L3
`just gate`. These tests never use production credentials or publish to npmjs.org;
an unavailable npm executable or blocked loopback socket fails the recipe.

`just crdt-e2e` exercises the `/yjs` and `/automerge`
adapters and rejects the earlier top-level import paths. Passing this proof
does not change their [maturity status](../../docs/concepts/current-status.md#experimental-integrations).
It builds and packs the SDK, verifies that its root imports without
the optional Yjs and Automerge peers, then installs both peers in a separate
temporary consumer. It typechecks and runs the reusable scene examples against
that packed SDK. Each engine creates two real replicas inside the same consumer
process and exchanges native Yjs updates or Automerge Sync messages through a
private loopback TCP relay. The examples exercise host admission and
revocation through `bindInteractions`, freeze and validate scene candidates,
reject stale and racing acceptance, and save/reload the accepted engine bytes.
This proves only the exercised local relay and example host path. The relay is
not authenticated and does not prove authorization of arbitrary inbound CRDT
updates, browser collaboration, cross-engine parity, or crash/power-loss
durability. Missing dependencies, blocked sockets, or failed packed-consumer
checks block this L5 recipe rather than passing silently.

`just websocket-room-smoke` builds the separate Node WebSocket example and runs
`tests/typescript/live/websocket-room.test.ts` against a real socket. The
native SDK streams and reconnects; the host deduplicates proposals and approvals.
This proof uses a deterministic provider fixture and does not establish live
Ollama behavior. It is part of L5 `just e2e`.

`just rust-mcp-modern-smoke` builds the native Rust wire fixture and connects the
current SDK through `@modelcontextprotocol/client/stdio`. It establishes modern
discovery, catalog parsing and preservation of an unknown synthetic outcome.
It does not establish a real application Binding or complete SDK parity.
