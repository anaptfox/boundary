---
title: "System map"
description: "End-to-end architecture from interaction declarations through projection, atomic binding, dispatch, plans, and Control."
---

# System map

This map shows how Boundary's pieces connect in `@foxworth/boundary`—from pure static declarations to live local dispatch, remote Handoff, static Plans, and optional Control.

## 1. The core lifecycle (pure static → live execution)

Everything above `bindProjection` is **pure and synchronous**—no `await`, no I/O, no runtime state required to inspect contracts or slice surfaces.

```text
Application or framework
  declarations (b.* or Zod)          handlers + policy + state
             │                                  │
             │ compileInteractions              │ installInteractions (realizeDirect)
             ▼                                  ▼
     CompiledInteractions            InteractionInstallation
       Program + handles               Catalog + live identity
             │                                  │
             │ project / pick / omit / union    │
             ▼                                  │
         Projection                             │
             │                                  │
             └──────── bind atomically ─────────┘
                               │
                               ▼
                       ProjectionBinding  (or createBindingSlot for atomic swaps)
                               │
                        stateless Caller  (call / direct.* / try.* / request)
                               │
                     actor / context per call
                               │
                      host admission seam
                               │
                       your handler runs
```

**Key invariants:**
- **Projection** and **Installation** are peers—neither contains the other. A Projection can exist with zero Installations; an Installation can contain extra interactions a caller never sees.
- **Binding** is atomic: every entry in the Projection binds compatibly, or `bindProjection` returns an exhaustive `unrealized` report with zero partial callers.
- **Adapters present the whole Binding.** There is no softer "hide from tool list" layer—if a caller must not see an interaction, bind a narrower Projection.

## 2. Two TypeScript authoring styles

Both styles produce the exact same `Program`, `Projection`, `Installation`, and `Binding` artifacts:

- **Concise (`createHost`):** One synchronous call that compiles, installs, projects, and binds direct callers, returning both named methods (`callers.*`, `tryCallers.*`) and every underlying artifact (`compiled`, `installation`, `projections`, `bindings`, revocation controllers).
- **Explicit (`compileInteractions` → `project*` → `installInteractions` → `bindProjection`):** Use when projections outlive installations, when combining modules (`composeCompiledInteractions`), when using `request` mode, or when hot-rebinding through `createBindingSlot`. Co-locate handlers and realization IDs with `realizeDirect` / `realizeRequest` (or pass `implementInteractions` / framework native dispatchers).

## 3. Ownership at a glance

| Boundary represents and checks | Your application authors and owns |
| --- | --- |
| Portable contracts, Programs, and deterministic digests | Interaction IDs, domain semantics, and schemas |
| Caller-specific Projections and set algebra | Which callers exist and which slices they receive |
| Live Installation availability and realization pins | Handlers, stores, routing, health, and failover |
| Atomic Binding, revocation controllers, and `BindingSlot` | Authentication, actors, and authorization policy |
| Input, output, and declared-error validation + `certainty` | Transactions, external APIs, and behavioral correctness |
| Handler-free `Plan` analysis (waves, minimal projection, preflight) | Plan execution loops, retries, and UI orchestration |
| Optional Control state-machine laws | Durable journals, policy, apply, verify, and reconcile hooks |

Selection is not authority. Availability is not permission. A matching digest is not proof of handler behavior.

## 4. Subpath map

```text
everyday host & authoring
  @foxworth/boundary              core host, b.* schemas, createHost, BindingSlot
  @foxworth/boundary/plan         handler-free Plans, parallel waves, atomic preflight
  @foxworth/boundary/testing      MemoryJournal, TestClock, contract-verification harnesses
  @foxworth/boundary/drafts       propose, accept, and reject Drafts
  @foxworth/boundary/observations observed-read capture and footprint reuse
  @foxworth/boundary/build        explicit loading and build-time artifact generation
  @foxworth/boundary/artifact     Node-only artifact verification and comparison

portable foundations
  @foxworth/boundary/program      portable contracts, identity, compatibility, b.*
  @foxworth/boundary/program/zod  explicit Zod schema adapter
  @foxworth/boundary/handoff      checked invocations across untrusted process seams
  @foxworth/boundary/control      proposals, grants, attempts, leases, reconciliation
  @foxworth/boundary/control/host Control → Host request-mode bridge

callers & platform adapters
  @foxworth/boundary/client       remote clients, reactive reads, cache scopes, remote errors
  @foxworth/boundary/http         Fetch/HTTP handlers, OpenAPI, SSE observations (+ /http/node)
  @foxworth/boundary/mcp          MCP server adapter (protocol 2026-07-28)
  @foxworth/boundary/webmcp       browser WebMCP adapter
  @foxworth/boundary/react        React hooks and cache provider (+ /react/styles.css)
  @foxworth/boundary/inspector    browser Binding inspector
  @foxworth/boundary/frameworks/* hono, next, trpc, vite
  @foxworth/boundary/cloudflare   Workers & Durable Objects helpers
  @foxworth/boundary/electron     sandboxed Electron IPC (+ /electron/ipc)

guests & discovery
  @foxworth/boundary/plugin       WIT projection, WASM component inspection and loading
  @foxworth/boundary/reach        Reach records
  @foxworth/boundary/bus          local discovery bus client

experimental
  @foxworth/boundary/yjs          read-only Yjs snapshot projection
  @foxworth/boundary/automerge    read-only Automerge snapshot projection
```

Direct-only apps stay completely Control-free: the bridge lives in `@foxworth/boundary/control/host`.

## 5. Local calls vs. remote calls

```text
local:
  Caller (call / direct.* / try.*) ──▶ Binding ──▶ admission ──▶ handler

remote:
  transport bytes ──▶ Handoff (decode & conserve pins) ──▶ opaque checked invocation
                                                                   │
                                                                   ▼
                                                     Binding.invoke ──▶ handler
```

Transports only parse and frame bytes; **Handoff** is the sole boundary that accepts untrusted serialized invocations. Remote clients pin a Binding manifest digest and explicitly re-handshake when an Installation is replaced.

## 6. Optional request path (Control)

```text
Caller.request
  ──▶ validate ──▶ admission ──▶ plan ──▶ Control policy ──▶ persist proposal

later, under separate ControlAdmin authority:
  approve ──▶ grant ──▶ attempt ──▶ apply ──▶ verify ──▶ receipt
                                      │
                                  uncertain ──▶ reconcile
```

Request mode never executes the underlying effect.

---

**Next:** Read [Interaction-first programming](./interaction-first-programming.md), walk through [Getting started](../guides/getting-started.md), or review [Guarantees and counterexamples](./guarantees.md).
