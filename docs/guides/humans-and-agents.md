---
title: "Humans and agents in the same application"
description: "Give people and agents different surfaces over the same application-owned work."
---

# Humans and agents in the same application

Imagine an editor and an assistant preparing an article. Both can inspect its
images and make thumbnails. The assistant may edit the draft, but publication
needs a person's review. When either changes something, the other needs an
accurate view of the result.

These are application interactions with different callers, not two applications
with separate definitions of editing and publishing. Boundary connects selected
interactions to each caller; the application owns permissions, data and UI.

## A projection is a capability interface, not a screen

A Projection selects declared interactions and their invocation modes. Its
presentation can describe those interactions without specifying a component
tree, form layout or renderer. The same interaction may appear as a button,
command-menu item or agent tool.

Keep three questions separate:

| Question | Where it is answered |
| --- | --- |
| Which interactions and modes are in this caller's surface? | Explicit Projection selection and its checked Binding |
| May this caller perform this particular action now? | Host authentication, admission and any required exact grant |
| Which records and fields may this caller read? | Application-owned read interactions and data policy |

A narrower tool listing is not a narrower Binding. Hiding a listed tool does
not revoke its underlying interaction. Likewise, selecting a read interaction does
not automatically redact private fields from its output. Author safe results
and check object and tenant access on the server.

The [caller guide](./adding-a-caller.md) shows selection and binding using the
thumbnail example. The [adapter reference](../reference/adapters.md) describes
the tool and protocol interfaces.

## Own the UI; import the interaction behavior

Use `@foxworth/boundary/client` for selected remote clients and
`@foxworth/boundary/client` for framework-neutral reactive reads.
`watchInteraction` supplies snapshots, subscription, refresh and disposal.
`@foxworth/boundary/react` adapts that read store to React and supplies explicit
interaction calls, pending state and error handling through `useInteraction`.

Your application renders the editor, chat, review panel and error messages.
Adopting Boundary does not require ejecting components into the app or adopting an
Boundary page schema. An example may use a rich editor, UI library or agent SDK;
those are choices for that application, not requirements for every Boundary user.

For controlled work, use the separate request and authorized status interfaces
described in [Control](../reference/control.md). A request-capable client does
not acquire approval or execution administration. A general task dashboard is
not implied by an interaction hook. See [availability and support](../concepts/current-status.md)
for the scope of the supplied interfaces.

## Delegate a job without granting every consequence

The host can admit reads and ordinary draft changes within a delegated
workspace while requiring request mode for designated consequential actions.
The application decides that classification; Boundary does not decide that every
edit needs review or that a task instruction authorizes every effect.

Record the agent executor and human delegator separately when delegation is
involved. Construct trustworthy context from authenticated application state.
A caller-provided actor ID or task ID is a claim to validate, not proof of
permission. Delegation may be revoked or narrowed independently of tool
presentation.

For a reviewed publication:

1. The selected request interaction prepares a public proposal without publishing.
2. An authorized person reviews the designated revision and consequences.
3. The host records approval and grants exact execution authority separately.
4. Execution establishes an attempt before applying, verifying and recording
   the result.

An application may present steps 2–4 as one "Approve and publish" interaction.
That is a server-side composition of distinct checks, not a general
administrative capability sent to the browser or agent. Apply the same rules
when a human initiates the original request.

If the response disappears after publication may have started, do not repeat
publication to find out what happened. Preserve uncertainty and reconcile
against application evidence. Stopping a bot is not proof that an effect was
cancelled or rolled back. See the [controlled effects guide](./controlled-effects.md).

## Make shared updates truthful

Interaction footprints can identify reads affected by a change. Mounted reads
sharing an explicit invalidation scope can refresh together. The scope itself
does not authenticate an event publisher or authorize access to data.

An agent running elsewhere does not update a browser merely because both use
Boundary. The host supplies authenticated event delivery or another refresh
mechanism. It chooses retention, replay and tenant/workspace routing, then
feeds appropriate observations into read invalidation. Authoritative reads
establish the displayed state; chat prose does not establish execution truth.

Reconnecting an observation stream and replacing a stale Binding are different
actions. A new installation needs a deliberate new connection. Neither action
authorizes replaying an outstanding effect or moving an old grant to a new
implementation. See [reactive reads](../reference/adapters.md#reactive-reads-foxworthboundaryclient)
and [explicit rehandshake](../reference/adapters.md#remote-client-and-explicit-rehandshake).

## Let the chosen runtime own the bot

Named bots, saved conversations, task scheduling, progress retention and
restart coordination belong to the application and its chosen agent runtime.
Boundary interactions can expose their application-owned work without becoming a
scheduler.

Persistence is a host/storage property, not a consequence of calling through
MCP or mounting a Fetch handler. A local process continuing after a browser
closes is different from a cloud worker continuing while the user's computer
is asleep.

For integration into Next, Vite, Hono, Workers, Durable Objects or Electron,
continue with the [native application guides](../README.md#native-application-guides).
For evidence boundaries and portability, consult
[availability and support](../concepts/current-status.md).

## Deliver observations across processes

`createObservationHttpHandler` from `@foxworth/boundary/http`
frames host-selected observations as a bounded SSE stream. The application
supplies `context(request)` for authentication and `subscribe(context, publish,
signal)` to select recipients and redact any correlation data. Returning a
Response from `context` rejects a subscription before attaching it. The stream
closes a slow subscriber when its bounded buffer fills; it has no replay log.

`subscribeToObservations` from `@foxworth/boundary/client`
connects a pinned client and explicit cache scope to that stream. Its `ready`
promise resolves after subscription and an authoritative read refresh. Relevant
observations refresh reads; they never repeat changes. `disconnect()` stops
delivery, `reconnect()` explicitly opens a fresh stream and refreshes reads to
cover the gap, and `dispose()` permanently retires the subscription. A failed
stream reports through `onError` and remains disconnected until the application
chooses to reconnect. New credentials or a new Binding require a new client and
subscription; this module never follows an installation replacement silently.

Use one explicit scope for the typed read, change store, and observation
subscription. `screenClient` is the checked client for the host's Binding;
`references` is its application-owned or generated typed reference data.
`observationOptions` supplies the host's events URL and authenticated fetch
options. It may also provide `onError` for connection feedback.

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#imports -->
```ts
import { createInvocationState, createProjectionClient, pinProjectionReferences } from "@foxworth/boundary/client";
import { createInteractionCacheScope, watchInteraction } from "@foxworth/boundary/client";
import { subscribeToObservations } from "@foxworth/boundary/client";
```

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#client -->
```ts
const handles = await pinProjectionReferences(screenClient, references);
const scope = createInteractionCacheScope();
const todos = watchInteraction(screenClient, handles.list, { scope });
const stopRendering = todos.subscribe(() => render(todos.getSnapshot()));
const createTodo = createInvocationState(screenClient, handles.create, "direct", { scope });
const subscription = subscribeToObservations(screenClient, { ...observationOptions, scope });
try {
  await subscription.ready;
} catch (error) {
  disposeView();
  throw error;
}
```

The read's first subscriber mounts it before readiness refresh. A read created
without `{ scope }` uses a separate client-local scope, so this subscription
would not refresh it. For React, pass this same scope to
`InteractionCacheProvider` around the components using `useInteraction`.
A scope shares invalidation, not authority or application state.

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#change -->
```ts
// Invoke only from the application's explicit event handler.
await createTodo.invoke({ title: "From screen" });
```

Handle a rejected invocation through its error and snapshot; an unknown outcome
requires host-owned reconciliation before any repeat. A user-requested
`subscription.reconnect()` refreshes mounted reads after a delivery gap and
never repeats changes. On logout or navigation, retire the view:

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#cleanup -->
```ts
subscription.dispose();
stopRendering();
todos.dispose();
createTodo.dispose();
```

Disposal blocks new invocation and removes listeners. Existing attempt evidence
remains readable from `createTodo`; preserve unresolved attempts for the
application's reconciliation UI before retiring that view. The
[executable scoped example](../../examples/snippets/typescript/scoped-observations.ts)
and [its test](../../tests/typescript/scoped-observations.test.ts) use in-process
Fetch/SSE and test identity. It establishes the typed wiring,
separate scopes, gap refresh, and no repeated changes; it does not establish a
mounted browser, real socket, production identity, or CRDT synchronization.

The [live example](../../examples/concepts/typescript/live-observations/README.md) and
[cross-process test](../../tests/typescript/live/observation-delivery.test.ts)
exercise host authentication, tenant delivery, uncertain changes, reconnect,
and cleanup over loopback. The stream adapter is a native TypeScript integration
of the shared observation record, not a new portable transport requirement.
