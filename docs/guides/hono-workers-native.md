---
title: "Native Hono and Worker invocation context"
description: "Mount a prepared Fetch handler and attach application context on Hono or Workers."
---

# Native Hono and Worker invocation context

The generic Hono and Worker mounts accept a prepared Fetch handler. Use them
when a raw `Request` is the only application context needed.

When the host needs framework-native request information, keep the Binding
prepared for the application's lifecycle and create the checked HTTP handler
for each invocation. This lets the host derive context from its authentication
middleware, route parameters, Worker bindings, and execution context without
putting a current request in module state.

## Hono

`createProjectionHonoMiddleware` receives Hono's typed `Context`. Its generic
type preserves the application's middleware variables, route parameters,
bindings, and available runtime execution context. The factory returns an
ordinary `HttpHandler`, normally made with `createHttpHandler` from an already
prepared Binding.

The [Hono native fixture](../../tests/fixtures/runtimes/hono/app.ts) shows a
server-side session lookup, tenant-specific application records, a prepared
Binding per tenant, and explicit middleware-derived context. Its accompanying
[native proof](../../tests/typescript/hono.native.test.ts) covers concurrent
tenant reads, a rejected cross-tenant write, typed native read/mutation route
composition, native response-header composition, and ordinary routing.

The Hono middleware and routes remain application-owned. The native helper is
not Hono RPC: it does not infer interaction routes, schemas, status codes, or
authority from an application route. `mountProjection(handler)` remains the
smaller option when the handler already has its request-context resolver.

## Cloudflare Workers

`createProjectionWorkerFetchWithContext` calls its factory only for matched
requests. The factory receives the exact `request`, `environment`, and
`execution` objects for that invocation. Fallback requests keep the
application's normal Worker routing and receive those same three values.

The [Worker native fixture](../../tests/fixtures/runtimes/cloudflare-worker/worker.ts) keeps
prepared tenant Bindings outside invocation handling, reads and writes the
application’s tenant records through its Worker KV binding, and exposes a
selected Binding through the existing version 1 Handoff protocol. Its
[native proof](../../tests/typescript/worker.native.test.ts) covers concurrent
tenant contexts, a rejected cross-tenant write, KV persistence invocation, and
fallback routing. The coordinator-run workerd smoke additionally exercises the
authenticated service-binding Handoff path plus malformed and stale requests.

The KV use is deliberately a small persistence example, not a concurrency
protocol: Workers KV is eventually consistent, offers no atomic read/write
transaction or cross-isolate serialization, and concurrent writes to one key
can overwrite each other. Do not use this shape for a same-tenant write path
that needs a current-state compare-and-swap, exactly-once effect fence, or
reconciliation ledger; put that state behind a host-selected strongly
consistent store instead. See Cloudflare’s [KV consistency guidance](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
and [concurrent-write guidance](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).

Worker environment values and service bindings are capabilities supplied to the
application, not end-user permission. The host must authenticate and admit
every invocation before it reaches a selected interaction; a request that only
has service-binding reachability is denied. `execution.waitUntil` is runtime
scheduling, not durable task completion or evidence that an effect finished.

## Authority and recovery

Selected interactions describe what the caller can address; they are not grants.
The host's context resolver and Binding admission still decide whether a
particular request can dispatch. Do not treat a Hono variable, path parameter,
Worker binding, or caller header as authority without host validation.

These helpers do not retain request context after the response and do not retry
an invocation. If a consequential effect may have begun but its result is lost,
report and reconcile the existing uncertain attempt rather than creating a new
one. See [controlled effects](./controlled-effects.md) for the exact-grant and
reconciliation path.

Runnable shapes are in [the Hono fixture](../../tests/fixtures/runtimes/hono/app.ts)
and [the Worker fixture](../../tests/fixtures/runtimes/cloudflare-worker/worker.ts).
Current support and acceptance coverage are recorded on the central
[availability page](../concepts/current-status.md), not in this guide.
