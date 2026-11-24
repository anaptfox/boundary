---
title: "Humans and agents in the same application"
description: "Give people and AI agents tailored surfaces over the same actions, honest shared updates, and approval-gated side effects."
---

# Humans and agents in the same application

Imagine a human editor and an AI assistant working on the same article. Both inspect images, generate thumbnails, and edit drafts—but only a person can publish. When either makes a change, the other needs to see the truth on screen.

Most teams accidentally build *two* applications here: one API for the UI and a parallel set of hand-rolled tools for the agent. In Boundary, **there is only one set of interactions.** People and agents simply bind different Projections over the same application.

## 1. Keep three security questions separate

A Projection is a capability surface—not a UI layout, and not a permission grant. The same interaction can render as a button, a CLI command, or an MCP tool. Never blur these three seams:

| Question | Where it is answered |
| --- | --- |
| Which actions and modes exist on this caller's surface? | Explicit **Projection** and its atomic **Binding** |
| May this authenticated actor run this call right now? | Host **admission** (and an exact **Control grant** for controlled effects) |
| Which records and fields may this actor see? | Application-owned read handlers and data policy |

Two sharp rules:
- **Hiding a tool from a list does not revoke it.** Adapters present the whole Binding; to remove an action from an agent, bind a narrower Projection.
- **Selecting a read does not redact fields.** Enforce tenant/object checks and return safe projections from your server handlers.

## 2. Own your UI; import the interaction plumbing

Boundary never forces a component library or page schema:
- Use `@foxworth/boundary/client` for checked remote clients and framework-neutral reactive reads (`watchInteraction`).
- Use `@foxworth/boundary/react` for React hooks (`useInteraction`, `InteractionCacheProvider`).
- Render your own editor, chat pane, review banner, and error states.

For controlled effects, keep request clients separate from approval/admin paths—a request-capable UI or agent never receives `ControlAdmin`.

## 3. Delegate drafts without granting every consequence

Your host can admit reads and ordinary draft edits inside a delegated workspace while routing publishing or deletion through `request` mode:

1. The agent calls `request` → Boundary prepares a reviewable proposal without publishing.
2. A human reviews the exact revision and declared consequences.
3. Your server records `approve` and `grant` separately.
4. Execution creates an attempt, applies at most once, verifies, and stores a receipt.

Record the agent executor and human delegator separately from trusted server authentication—never trust an actor ID supplied in untrusted input. And if a network drop leaves a publication `uncertain`, reconcile against reality rather than retrying (stopping an agent does not roll back an in-flight side effect). See [Controlled effects](./controlled-effects.md).

## Make shared updates truthful

Because interactions declare `reads` and `changes`—either globally (`"documents"`) or scoped per record (`"document:{input.id}"`)—Boundary knows which live views are invalidated by a change. Mounted reads sharing an explicit invalidation scope refresh together.

Be clear on what crosses processes: an agent running in another process does not magically update a browser just because both use Boundary. Your host delivers authenticated observations (e.g., via SSE or WebSocket) into the client's invalidation scope, and authoritative reads—not chat prose—establish what the screen shows.

Reconnecting an observation stream and replacing a stale Binding are separate operations: a new installation still requires an explicit new handshake and never replays an in-flight effect. See [reactive reads](../reference/adapters.md#reactive-reads-foxworthboundaryclient) and [explicit rehandshake](../reference/adapters.md#remote-client-and-explicit-rehandshake).

## Let your chosen runtime own the bot

Named bots, saved threads, schedules, and restart recovery belong to your application and agent runtime—Boundary exposes your application's interactions cleanly without becoming a scheduler. See the [native application guides](../README.md#native-application-guides) for Next, Vite, Hono, Workers, Durable Objects, Electron, and Bun setups.

## Deliver observations across processes

`@foxworth/boundary/http` provides `createObservationHttpHandler` to stream host-selected observations over bounded SSE. Your app supplies `context(request)` for authentication (returning a `Response` rejects before subscribing) and `subscribe(context, publish, signal)` for recipient filtering and redaction. Slow subscribers close when the bounded buffer fills; there is no built-in replay log.

On the client, `subscribeToObservations` from `@foxworth/boundary/client` links a pinned client and explicit cache scope to that stream:
- `subscription.ready` resolves only after subscribing *and* running an authoritative read refresh.
- Incoming observations refresh matching reads—never repeating mutations.
- `disconnect()`, `reconnect()` (re-opens + refreshes to cover any gap), and `dispose()` keep lifecycle explicit.

Share one explicit `scope` across your read watcher, mutation store, and observation stream:

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

Pass that same `scope` to `InteractionCacheProvider` in React so `useInteraction` refreshes automatically. A scope shares invalidation signals only—never authority or state.

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#change -->
```ts
// Invoke only from the application's explicit event handler.
await createTodo.invoke({ title: "From screen" });
```

Handle rejected or `unknown` outcomes explicitly before retrying. On logout or navigation, dispose cleanly (preserving any unresolved attempt references for your reconciliation UI):

<!-- snippet:examples/snippets/typescript/scoped-observations.ts#cleanup -->
```ts
subscription.dispose();
stopRendering();
todos.dispose();
createTodo.dispose();
```

See the [executable scoped example](../../examples/snippets/typescript/scoped-observations.ts), [its tests](../../tests/typescript/scoped-observations.test.ts), and the [cross-process live observations example](../../examples/concepts/typescript/live-observations/README.md) for loopback SSE delivery, tenant filtering, reconnects, and cleanup.
