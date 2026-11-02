# Runtime proof fixtures

These fixtures support executable framework and transport proofs. They are
deliberately smaller than user-facing examples and are not production
application templates.

- `cloudflare-worker` — Cloudflare Worker fetch integration.
- `durable-object` — a real Durable Object and host-owned Control journal.
- `electron` — trusted Electron protocol and IPC integration.
- `hono` — native Hono mounting.
- `vite` — Vite lifecycle replacement and recovery.

Use the corresponding root `justfile` recipes. `just framework-smoke` exercises
the in-process framework set, while `just e2e` adds proofs requiring installed
real runtimes. A missing runtime is blocked, never passed.
