# Agent changes refresh a human view across processes

Run from the repository root with the repository's Node version and installed
workspace dependencies:

```sh
node examples/concepts/typescript/live-observations/run.mjs
```

The launcher uses the existing `tsx` loader resolved through Vite. It starts a
separate Node host on an ephemeral loopback port, generates two tenant credentials,
and shuts the host down when the demonstration ends. No package installation is
performed by the launcher.

The human client mounts `counter.read`. The independent agent client calls
`counter.increment` over the existing Handoff HTTP protocol. The host publishes
an invocation observation over its authenticated SSE endpoint; the human client
refreshes its authoritative read. The example prints values 0, 1, 2, and 3:

1. Subscription readiness refreshes the initial read.
2. A completed agent mutation refreshes the human view.
3. An applied mutation whose implementation subsequently throws remains uncertain
   to the agent. Its observation refreshes the human read to 2; no mutation retry
   occurs. Observing the counter does not change the invocation's uncertainty.
4. A mutation occurs while disconnected. Explicit reconnection refreshes the read
   to 3, covering the delivery gap without replaying the mutation.

`host.ts` owns application state, authentication, tenant routing, admission, the
Node HTTP bridge, and subscription lifetime. Tenant correlation is used only for
host-side routing and removed before delivery. SSE observers receive contract and
installation pins, outcome classification, and footprints, without input/output
payloads. Every protocol and diagnostics request is authenticated too.

The second installation at `/other` shares the demo's application data but has a
different installation identity. Its events deliberately do not refresh the
primary installation's mounted reads. The live test also checks tenant isolation,
redaction, unauthorized subscriptions, disposal, and exact mutation counts:

```sh
node node_modules/vitest/vitest.mjs run --config config/vitest.live.config.ts tests/typescript/live/observation-delivery.test.ts
```

These are real localhost sockets and a separate host process. A sandbox must
permit loopback listeners. This example demonstrates live refresh, not a durable
replay log or exactly-once event delivery. The host chooses production credential
management and delivery policy; the client reconnects explicitly after a gap.
