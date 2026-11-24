---
title: "What Boundary provides"
description: "A clean ownership line between your application's behavior and Boundary's checked interaction layer."
---

# What Boundary provides

Boundary is deliberately narrow: it gives your application an explicit, checked agreement between callers and implementations—without taking over your storage, framework, transport, or business rules.

In the [thumbnail example](./interaction-first-programming.md), your application owns image processing. Boundary checks whether an installation fulfills a caller's declared contract before connecting them, validates data at the seam, and passes every call through your admission rule.

## The ownership line

When a helper only has one local caller and both change together, keep it an ordinary function. Reach for Boundary when an action's contract needs to outlive one caller, process, language, or deployment: a separate UI, a CLI, an AI agent, a plugin, or a worker.

| Your application owns | Boundary provides |
| --- | --- |
| What each action means (`images.makeThumbnail`) | Canonical portable contracts and deterministic digests |
| Stores, rendering, transactions, and side effects | Fail-closed validation of inputs, outputs, and declared errors |
| Authentication, actors, and authorization policy | Per-call admission seam (and typed `AuthorizedContext` narrowing) |
| Which actions each caller should get | Set-algebra Projections (`pick`, `omit`, `union`, `intersect`) and atomic Binding |
| Runtime health, transports, retries, and deployment | Pinned installation/realization IDs and atomic `BindingSlot` swaps |
| Proof that results are business-correct | Exhaustive `unrealized` reports, typed `certainty`, and contract-verification harnesses |

Both sides stay decoupled until Binding:

```text
your declarations                    your implementations
        │                                     │
        ▼                                     ▼
     Program                             Installation
        │                                     │
        ▼                                     │
    Projection ─────── atomic binding ────────┘
                             │
                             ▼
                           Caller
                             │
                  admission on every call
                             │
                     your code runs here
```

## Adopt only the layers you need

- **Zero-ceremony direct path (`@foxworth/boundary`):** Declare interactions with zero-dependency `b.*` (or Zod), wire handlers and callers synchronously with `createHost`, and call with named methods (`callers.*`) or exhaustive typed outcomes (`tryCallers.*`).
- **Explicit lifecycle (`@foxworth/boundary`):** Use `compileInteractions`, `Projection` set algebra, `installInteractions` (`realizeDirect`), `bindProjection` / `bindAuthorizedProjection`, and `createBindingSlot` when projections and installations live independently or hot-rebind.
- **Static multi-step workflows (`@foxworth/boundary/plan`):** Describe DAGs over interactions to derive minimal projections, parallel waves, and atomic preflight checks before step 1 runs.
- **Process seams (`@foxworth/boundary/handoff` + adapters):** Frame calls over HTTP, MCP, WebMCP, React, Workers, Electron, or WASM plugins without duplicating contract checks.
- **Consequential effects (`@foxworth/boundary/control`):** Opt into `request` mode (proposals → approval → grant → attempt → verify → reconcile) only for actions where "the function returned" isn't enough evidence. Direct-only apps never import Control.

## What Boundary does *not* do

Boundary does not provision workers, pick your database, run background queues, make handlers transactional, or silently migrate callers when a contract breaks.

Two honesty rules to keep in mind:
1. **A matching contract is not proof of correctness.** Passing validation proves declared shapes and footprints match—not that a thumbnail looks sharp or a handler obeyed its declared `changes`.
2. **A Projection is not permission.** Selecting an action makes it *reachable* on a surface; your host admission function still decides whether a specific authenticated actor may call it right now.

---

**Next:** Walk through the live code in [Build a thumbnail tool](../guides/getting-started.md), check [Who Boundary is for](./audience.md), or review [Availability and support](./current-status.md).
