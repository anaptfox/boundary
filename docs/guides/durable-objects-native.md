---
title: "Durable Objects: application-owned composition"
description: "Keep one durable state machine per entity in an application-owned Durable Object."
---

# Durable Objects: application-owned composition

Use a Durable Object when an application needs one durable, coordinated state
machine per logical entity, such as a workspace. Boundary does not supply that
state machine. The application owns the Durable Object class, SQLite schema,
migrations, RPC methods, alarms, WebSockets, authorization, and deployment
lifecycle. Boundary remains an ordinary checked handler field in that class.

The small direct-composition sketch in
[`tests/fixtures/runtimes/durable-object/workspace.ts`](../../tests/fixtures/runtimes/durable-object/workspace.ts)
illustrates the boundary only; it is not an accepted native lifecycle proof.
The application constructs native request context from its authenticated
request or RPC boundary. A Projection selects available interactions; it does
not grant a caller authority.

`createSurfaceDurableObject()` remains a valid generic job where an
application wants only a fetch-class mount. A native Durable Object app should
own its own class and directly hold its prepared handler.

## Identity and reconstruction

An application should persist the identity it needs to distinguish a
reconstruction from a replacement next to its state. In the bounded fixture,
that is `{ workspaceId, deploymentId }`; it derives the concrete Boundary
installation and realization pins on attachment. A production application that
needs further identity evidence must store it itself. In every case, same
identity means reconstruction, not a recreated grant; a replacement must
reject stale invocations through the existing checked path. Matching only a
Program or contract digest is not enough to restore authority.

The executable SQLite fixture is
[`tests/fixtures/runtimes/durable-object/worker.ts`](../../tests/fixtures/runtimes/durable-object/worker.ts).
It compiles selected `workspace.read` and `workspace.increment` interactions,
binds them to the application-owned workspace, and serves the existing Handoff
protocol with a deterministic server-side session fixture. The companion smoke
client creates invocations using the real `createHandoffInvocation` helper;
it does not construct identity pins by hand.

Attachment is explicit rather than automatic: on each object construction,
the authenticated host route calls the object's attach endpoint with the
server-owned workspace route and its environment deployment ID before serving
the protocol. The fixture's owner session may request that route, but cannot
set the deployment ID. This models host lifecycle admission; it is not an
implicit Durable Object reconstruction hook.

## Native lifecycle remains native

Use deterministic DO names for a logical workspace where that is the
application's routing policy. Keep SQLite transactions synchronous and do not
assume single-threaded execution makes asynchronous external I/O atomic.
Cloudflare's DO guidance describes one globally unique, single-threaded object
with persistent storage per coordination atom, and recommends native RPC for
DO method invocation. [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

An alarm is at-least-once domain lifecycle delivery, not a general scheduler or
a confirmation that an external effect completed. The executable fixture owns a
SQLite `ControlJournal` and an exact `workspace_increment_effects` ledger. The
alarm reconciles that durable evidence; it never calls `apply`. An active lease
is rescheduled after its expiry, while records from a replaced installation are
recorded as stale and skipped without retrying their effect. See Cloudflare's
[alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/) and
Boundary's [controlled effects guide](./controlled-effects.md).

The native workerd smoke proves request, approval, grant, lost acknowledgement,
two platform-delivered reconciliation wakes, and reconstruction without a
second increment. It also opens two native WebSocket connections, verifies
workspace-scoped observations, and reconnects for a fresh snapshot. The smoke
does not prove a live socket survives a deployment replacement: replacement is
fenced by the persisted generation and closes stale sockets; the local runtime
is recreated for the replacement proof.
