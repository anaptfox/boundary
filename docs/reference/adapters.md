---
title: "Adapter reference"
description: "Translate one selected Boundary interface into a caller-native interface."
---

# Adapter reference

Adapters translate one explicitly selected Boundary interface into a caller-native
interface. They do not discover interactions, create a second dispatcher, infer
domain meaning, broaden modes, establish policy, or mint authority.

Descriptive adapters such as OpenAPI may consume a durable unrealized
Projection. Every adapter that can execute takes a connected caller (the value
`connect()` or the pipeline's `createCaller(binding)` returns) or a remote
client pinned to its version 1 Binding manifest. A caller carries its Binding
manifest and Handoff seam and no controller, so handing it to an adapter can
neither widen nor revoke anything.

## Shared execution seam

```ts
const todos = await app.connect(surface(docs, { call: ["list", "create"] }), { admit });
const routes = [
  route(todos, "list", {
    method: "GET",
    path: "/todos",
  }),
  route(todos, "create", {
    method: "POST",
    path: "/todos",
    successStatus: 201,
  }),
];

const handler = createHttpHandler({
  caller: todos,
  context: request => contextFromRequest(request),
  routes,
});
```

A declaration names an alias the caller selected; `mode: "call"` or
`mode: "propose"` picks the verb when the alias is selected for both. The
handler invokes through the caller's Handoff seam to validate selection and
dispatch. Its context resolver creates a stateless per-invocation host value;
Handoff passes that exact reference to admission and the installed realization
without serializing it.

A Binding manifest, cookie, header, bearer token, MCP principal, or Electron
channel is not authority by itself. Each adapter resolves native request data
into context, and the Binding's admission interface makes the host decision.

Request-mode handles create proposals only. No execution adapter receives
`ControlAdmin`; approval, grant, execute, and reconcile remain separately
distributed capabilities.

## HTTP and callers — `@foxworth/boundary/http`

HTTP, clients, and framework adapters have distinct subpaths. Import the
capability your application uses:

| Export | Owns |
| --- | --- |
| `@foxworth/boundary/client/cache` | footprint invalidation for mounted reads |
| `@foxworth/boundary/client` | typed version 1 Binding client and explicit interaction stores |
| `@foxworth/boundary/remote` | sanitized protocol errors |
| `@foxworth/boundary/http` | explicit routes and Fetch handler |
| `@foxworth/boundary/http/compose` | explicit handler composition |
| `@foxworth/boundary/http/openapi` | OpenAPI 3.1 description |
| `@foxworth/boundary/http/protocol` | Handoff wire handler and transports |
| `@foxworth/boundary/remote` | declaration-to-Binding resolution |
| `@foxworth/boundary/remote` | JSON-safe version 1 result envelopes |
| `@foxworth/boundary/remote` | projector schema helpers |
| `@foxworth/boundary/frameworks/trpc` | explicit tRPC procedures and handler |
| `@foxworth/boundary/http/node` | Node HTTP/Fetch bridge |
| `@foxworth/boundary/frameworks/hono` | generic handler mount and typed per-request Hono middleware |
| `@foxworth/boundary/frameworks/next` | App Router method exports and direct server interaction |
| `@foxworth/boundary/frameworks/vite` | Vite/Connect mount and explicit host-generation lifecycle |
| `@foxworth/boundary/http/observations` | host-authenticated SSE observation stream |
| `@foxworth/boundary/client/observations` | pinned-client observation subscription and read refresh |

`route(handle, options)` supports GET, POST, PUT, PATCH, and DELETE. GET uses
query plus path parameters by default; other methods use JSON body plus path
parameters. A custom input mapper may translate another native shape. Input
arity comes from the projected handle and is never inferred from a function's
`.length`.

`createHttpHandler` returns `(Request) => Promise<Response>`. It exposes only
the supplied routes, calls one Binding, returns identity-bearing version 1
outcomes, preserves declared errors, and sanitizes arbitrary realization
failures.

`openapi({ projection, routes, title, version })` emits OpenAPI 3.1 for exactly
the supplied descriptive declarations. It needs no Installation or Binding and
cannot execute. A route with an opaque custom input mapper is rejected because
its external schema cannot be inferred safely.

`createProtocolHandler` frames the version 1 handshake, invocation, and outcome
around an injected Binding. `fetchTransport` carries those bytes. Neither
reimplements Handoff validation.

## Remote client and explicit rehandshake

```ts
const client = createSurfaceClient(
  fetchTransport({ baseUrl: "/_boundary" }),
);

const manifest = await client.inspect();
const todos = await client.call(todoReferences.list);
const proposal = await client.request(todoReferences.remove, { id: 42 });
```

`createSurfaceClient` validates and pins one
`BindingManifest`, including `bindingDigest`, Projection and
Installation identity, expected and actual Programs and contracts, exact mode,
arity, and `RealizationId`. It sends only version 1 invocations and validates
that every version 1 outcome echoes those pins.

A changed deployment, Installation, realization, Projection, or Binding
requires an explicit new handshake. The client never silently follows a newer
manifest. It rejects every other wire version; there is no dual-stack client or
compatibility facade.

Application-owned or generated remote references are data only. They contain
the exact Binding pins needed for the selected interaction; callable native
handles and implementations never cross. Request preview typing is generated
only after successful request-mode Binding because the preview/control identity
belongs to that actual contribution, not to the unrealized Projection alone.

`handlesFromBinding(client)` hydrates projected handles from that handshake,
and `client.inspect()` returns the manifest itself, which WebMCP and other
declarations accept as a source (`webMcpTool(manifest, "get", ...)`).
`pinSurfaceReferences(client, references)` revalidates generated references
against the current handshake before the UI treats one as callable. The browser
does not compile interactions to call.

`client.call` returns validated portable output or a declared domain error.
`client.request` returns one typed public proposal. It cannot approve, grant,
execute, retry, reconcile, or mint host authority.

`mountHandlers` dispatches explicit protocol prefixes. The host still supplies
each Binding, context resolver, path, and tool list. `fetchTransport.invoke`
accepts optional per-call `headers` so a page can stamp claims without putting
them in the invocation body.

## MCP — `@foxworth/boundary/mcp`

`tool(caller, alias, presentation)` maps one selected alias to one explicit
MCP tool name and presentation; `mode: "call"` or `"propose"` picks the verb
when both are selected. `toolsFor(caller)` is that mapping for every selection:
`call` tools keep the interaction id as their name and `propose` tools add
`.propose`. `createMcpServer` and `createMcpHandler` take a connected caller
plus a context resolver. They expose only supplied tool declarations.
Changing a tool name does not change interaction identity. The context resolver
receives the official `extra` (including `extra.http.req`) and a `request`
when the SDK supplied one. The tool list presents the caller's Binding;
omitting a selected interaction from it hides nothing and changes no admission.
`serveHost({ doors, mcp })` composes protocol doors and an optional MCP mount
into one Fetch handler. MCP `tools` is a fixed array for the life of that
handler; a model that must see less is served a caller of a narrower Surface.

The adapter requires `@modelcontextprotocol/server` 2.3.1 or later and serves
protocol **2026-07-28**. HTTP handlers reject legacy protocol requests.
`extra` is the upstream `ServerContext`; verified identity is available at
`extra.http?.authInfo` after the host passes it to `handler.fetch`.

`tool(caller, alias, { scopeChallenge })` accepts the upstream scope preflight.
The host authenticates before selecting a Binding; scope checks only narrow
admission. `createMcpHandler(options, handlerOptions)` and
`serveHost({ mcp: { handlerOptions, ... } })` expose body limits and response
configuration, with the legacy switch excluded. `maxToolInputElements` bounds
server validation work. `await serving.dispose()` waits for MCP shutdown.

Every tool result carries the checked outcome unchanged as `structuredContent`
and opens `content[0].text` with one reviewed sentence a model can act on:
success, a declared error with its code, denied (nothing ran), invalid (fix the
input and call again), proposed (a Proposal awaits host review; the effect has
not run), or uncertain (the effect may have run; do not repeat it; check with
the named installation). A revoked Binding reads as an outdated view of the
surface. `isError` is set for everything but success and proposed.
`tests/conformance/v1/mcp-envelope.json` pins the wording for this adapter, the
WebMCP adapter, and the Rust MCP server.

The MCP adapter does not reserve transport, authentication, server lifecycle,
tool selection, or administrative Control authority. Arbitrary host failures
are sanitized by the same Handoff interface used by every other transport.

## WebMCP — `@foxworth/boundary/webmcp`

`isWebMcpAvailable()` detects `document.modelContext.registerTool`.
`registerWebMcpBinding({ caller, tools, context })` registers an explicitly
supplied in-process caller and presentation map on that port.
Registration is asynchronous and each published tool receives its own
`AbortSignal`. Disposing a registration withdraws that tool from the document;
it does not cancel an invocation that the browser has already started.
`registerWebMcpTransport()` presents one already-pinned remote Binding through
an explicit Handoff transport; its tools are declared from the inspected
manifest. `webMcpTools(source)` maps each selection the same way
`webMcpTool(source, alias)` does. `webMcpTool(source, alias, { exposedTo })`
forwards the spec's per-tool origin allowlist; same-origin callers and the
browser agent stay visible without it.

The page must be a secure, origin-keyed context. Cross-origin iframes also
need `allow="tools"` (Permissions-Policy `"tools"`, default `'self'`). Chrome
origin-trial hosts must send the trial token on the registering document.
The browser then rejects `registerTool` with `NotAllowedError` or
`SecurityError`. The adapter does not call `getTools()` or
`executeTool()` — those are in-page agent APIs, not a Binding surface. It
does not discover an application, receive native realizations, or acquire
Control administration.

`sync({ caller, tools })` replaces the registered live surface after
validating its new version 1 manifest. There is no way to register a subset of
that surface: a page that must expose less syncs a caller of a narrower
Surface. Changing a tool's contract, mode, origin list, title, description,
or browser annotations unregisters and republishes it, so browser metadata and
the registration summary stay consistent. Presentation changes do not change
interaction or Program identity. Unchanged tools retain their registration.
`dispose()` is idempotent. Optional `onActivity({ toolName, state })` observes
`toolactivated` / `toolcancel` for this registration's live tools when the browser
supports events. States are `started` and `cancelled`; neither is execution
completion evidence. Disposal removes listeners. A register-only port remains
supported.
Request-mode tools create proposals only; their description says so. A
registered tool's `execute` returns the same envelope as the MCP adapter:
`content[0].text` opens with the reviewed summary and `structuredContent` is
the checked outcome unchanged (`WebMcpToolResult`). The page remains usable
when WebMCP is absent.

`webMcpTool(source, alias, { consequentialHint, debugging, untrustedContentHint })`
lets the host describe consequences, developer-only intent, and untrusted
output. By default, `consequentialHint` is true for direct tools with declared
changes and false otherwise; the host can override it explicitly.
`debugging` is only published when supplied. These annotations do not select
an execution mode, grant authority, or promise browser confirmation. Admission
and request handling still pass through the same checked Binding.

## Reactive reads — `@foxworth/boundary/client/cache`

`watchInteraction(client, reference, input?, { scope })` is the small
framework-neutral read store for a projected direct interaction. It returns
stable `getSnapshot`, `subscribe`, `refresh`, and `dispose` methods. The
reference keeps its declared input and output type; a zero-input read takes no
dummy value.

```ts
const board = watchInteraction(client, references.board, { workspaceId }, { scope });

const stop = board.subscribe(() => render(board.getSnapshot()));
await board.refresh(); // explicit retry or user refresh
stop();
board.dispose();
```

Creation is inert. The first subscriber fetches the read, and a later
`refresh()` works without a subscriber. Each watch owns one snapshot and keeps
the last successful value while a refresh is pending or fails. Overlapping
refreshes share the in-flight call; an invalidation that arrives after dispatch
causes one trailing read. `dispose()` is idempotent and stops publishing late
results, although the chosen transport may not be cancellable.

Before calling the client, the watch checks the pinned Binding, direct mode,
arity, contract identity, and declared footprint. A request-only, stale, or
changing interaction is rejected without dispatch. A watch never executes a
mutation. Its `scope` participates only in footprint invalidation; it does not
grant authority, authenticate an event publisher, or route application events.
Hosts decide when an authenticated event may call
`invalidateReadsForObservation` for a particular scope.

## React — `@foxworth/boundary/react`

For explicit changes and proposals, `createInvocationState` and
`createProposalInteraction` from `@foxworth/boundary/client` expose
framework-neutral state without invoking on creation. `useInvocationState`
and `useProposalInteraction` adapt those stores to React. Status reading is an
application-supplied authenticated public function, not possession of Control
administration. See [headless interactions](../guides/headless-interactions.md).

`createSurfaceContext<Client>()` returns a typed `Provider`, `useClient`, and
`view(Component)`. Components receive only the client capability.

`InteractionCacheProvider` owns one shared invalidation scope for mounted reads.
`useInteraction(client, reference, ...args)` exposes `data`, `error`,
`isPending`, `refetch`, and `call`. A change invalidates mounted reads whose
`reads` footprint intersects its `changes` footprint, including reads mounted
on other clients that share the same resource. `invalidateReadsForChange`
lives on `@foxworth/boundary/client/cache` so a non-React client can refresh the
same way. Declared reads use that same `watchInteraction` store through
`useSyncExternalStore`; React does not maintain another read cache. Mutations
remain explicit calls and never subscribe or auto-execute.
`describeInteractionError` separates declared errors from sanitized protocol and
execution faults; `isDomainErrorFor` narrows a caught error to one interaction's
declared domain error.

These are headless interaction interfaces. The application supplies its own
editor, chat, review controls and visual design; a Projection does not contain
a page layout. Descriptive metadata does not authorize an invocation or redact
private fields from a read result. For delegated jobs and the separate
interaction, world and agent-runtime responsibilities, see
[humans and agents](../guides/humans-and-agents.md).

## Framework and runtime adapters

Generic mounts connect an already-created handler. Native helpers additionally
connect explicit host-owned context and lifecycle functions. Neither compiles
interactions, installs a host, widens a Projection or establishes authority.

`createNextServerCaller({ caller, context })` wraps a connected caller for
direct server reads and actions without self-HTTP: `read.<alias>(input)`,
`action.<alias>(input)`, and `action.propose.<alias>(input)`. `createSurfaceHonoMiddleware` lets a host derive
context from typed Hono middleware and routes. Worker matched invocations can
use `createSurfaceWorkerFetchWithContext` to retain request, environment and
execution context. Existing generic Hono and Worker mounts keep their raw Fetch
handler interface. See [Next](../guides/next-native.md) and
[Hono/Workers](../guides/hono-workers-native.md) for the native paths.

Vite's `createSurfaceViteLifecycle` and `mountSurfaceLifecycle` manage
explicit candidate publication and disposal, with host-owned generation
identity. [Vite lifecycle](../guides/vite-native.md) explains failed replacement
and stale clients. An [application-owned Durable Object](../guides/durable-objects-native.md)
can compose Boundary directly while retaining its class, storage, RPC and alarms.

Electron IPC requires an explicit native sender policy before dispatch; the
host derives context only after validation. A renderer payload or URL alone is
not window/workspace authority. See [trusted IPC](../guides/electron-native.md).

| Import | Interface | Host-owned choice |
|---|---|---|
| `@foxworth/boundary/frameworks/vite` | `mountSurface({ handler, mount })`, `createSurfaceMiddleware` | mount path and Vite lifecycle |
| `@foxworth/boundary/frameworks/next` | `createSurfaceHandlers(handler)` | App Router files and segment config |
| `@foxworth/boundary/frameworks/hono` | `mountSurface(handler)` | route or prefix |
| `@foxworth/boundary/cloudflare` | `createSurfaceWorkerFetch`, `createSurfaceDurableObject` | routing, environment, and durable state |
| `@foxworth/boundary/electron` | `createSurfaceElectronMain`, `prepareSurfaceElectron`, `createElectronIpcFetch`, `electronIpcTransport` | scheme, port, session, channel, window, and renderer URL |

`createSurfaceElectronMain` mounts one injected handler in the main process.
`prepareSurfaceElectron` registers the supplied scheme before `app.ready`.
A sandboxed renderer reaches the same Binding through
`createElectronIpcFetch` or `electronIpcTransport`; it does not gain host or
Control authority.

These mounting functions do not supply a task runtime, a durable observation
stream, automatic Next cache integration, or Vite host hot replacement. Consult
the [native application guides](../README.md#native-application-guides)
and [availability and support](../concepts/current-status.md#framework-and-interaction-coverage)
before interpreting a transport/build smoke test as a complete native workflow.

## tRPC — `@foxworth/boundary/frameworks/trpc`

`procedure(caller, alias, { name, kind, mode? })` declares an explicit query or
mutation over one selected alias. `createTrpcRouter({ caller, context, procedures })`
builds a router for supplied procedures and one context resolver. `createTrpcHandler` exposes that router at an explicit Fetch
endpoint.

## Conservation law

Every execution adapter preserves the version 1 Binding pins byte-for-byte:
Binding digest, Installation ID and digest, host-authored interaction ID,
expected and actual contract digests, mode, realization ID, arity, and request
preview/control identity where present.

An adapter may translate framing, routing, encoding, or presentation. It may not
invent an interaction, broaden a footprint, change mode, silently rehandshake,
bypass admission, flatten `unknown`, or claim administrative Control authority.

## Live observations

- `@foxworth/boundary/http/observations`: `createObservationHttpHandler` accepts
  a host-authenticated context and a host-owned subscription function. It emits
  bounded SSE and releases subscriptions on disconnect.
- `@foxworth/boundary/client/observations`: `subscribeToObservations` refreshes
  the selected installation's mounted reads on initial connection and explicit
  reconnect, then applies scoped observation invalidation. It never retries an
  effect or grants authority.

See [human and agent delivery](../guides/humans-and-agents.md#deliver-observations-across-processes)
for lifecycle and delivery limits.

## Electron renderer entry

Import `electronIpcTransport` from `@foxworth/boundary/electron/ipc` in a renderer bundle.
This entry excludes the Node HTTP and window adapter; the main process continues
to import `createSurfaceElectronMain` from `@foxworth/boundary/electron`.

## Read-only CRDT snapshots

**Status: experimental.** These Boundary adapters are for evaluation; their
APIs may change incompatibly and have no production support commitment. See
[availability and support](../concepts/current-status.md#experimental-integrations).

`@foxworth/boundary/yjs` and `@foxworth/boundary/automerge` capture a local
document version and expose copied encoded bytes plus an asynchronous JSON
projection. Capture is synchronous; every `read` uses a fresh materialized
document and holds it until an asynchronous projector settles. A read does not
access the source document again. Returned data is normalized through the
portable JSON boundary.

| Import | Version marker | Captured bytes | Engine limitation |
|---|---|---|---|
| `@foxworth/boundary/yjs` | `frontier`: hex encoded Yjs snapshot, including its delete set | Full-state Yjs update | Attached subdocuments are refused because their contents are not in the parent update. |
| `@foxworth/boundary/automerge` | `heads`: copied heads from the captured clone | `Automerge.save` bytes from that clone | Project plain JSON; do not return an Automerge proxy as portable data. |

These are read-only snapshot helpers, not execution adapters or authority
surfaces. They do not synchronize or mutate replicas, persist bytes, assign
application IDs, validate domain schemas, or decide whether a captured value
may be accepted. The host owns metadata, schemas, candidate storage, peer
policy, persistence, and synchronization. Yjs document configuration,
provider/awareness state, and subdocument contents are outside the captured
parent update.

See the [CRDT snapshot guide](../guides/crdt-snapshots.md) for usage, official
engine references, and the limits of the local replica example.
