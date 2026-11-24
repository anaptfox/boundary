---
title: "Learn Boundary"
description: "Build the intuition from one opaque function to sliced interfaces, plugins, plans, and controlled effects."
---

# Learn Boundary

Boundary starts with one simple shift: separate **what an application action promises** from **the code that runs it**. Once an action is an inspectable value instead of an opaque function, you can slice caller interfaces like sets, verify contracts before running a single handler, refresh views from declared `reads`/`changes`, preflight multi-step plans, and govern consequential effects—all over the same description.

## 1. Build the intuition (recommended path)

Follow one small image app from a single button to a script, a broken contract, a WASM plugin, and an AI agent:

1. [Why interactions?](./concepts/interaction-first-programming.md) — see why ordinary functions break across callers and what turning them into values unlocks.
2. [Build a thumbnail tool, then change it](./guides/getting-started.md) — run it, swap implementations, deliberately break a contract, and add an agent without changing a single definition.
3. [Add another caller](./guides/adding-a-caller.md) — slice a narrow surface, bind it atomically, and connect transports.
4. [Load a plugin](./guides/plugins.md) — realize `images.makeThumbnail` in a WebAssembly component and watch the host reject ungranted imports.
5. [Controlled effects](./guides/controlled-effects.md) — separate proposing from acting and handle uncertain outcomes honestly.

Want to check fit or release posture first? Read [Who Boundary is for](./concepts/audience.md) and [Availability and support](./concepts/current-status.md).

## 2. Bring your own application

- [Concise native authoring](./guides/concise-authoring.md) — the shortest TypeScript entry (`createHost`, named callers, typed `tryCallers`)
- [Portable schemas](./guides/portable-schemas.md) — zero-dependency `b.*` schemas, Zod, and fail-closed validation
- [Compose native modules](./guides/module-composition.md) — combine declarations from multiple modules into one Program
- [Humans and agents in the same application](./guides/humans-and-agents.md) — shared updates, SSE observation streams, and least-privilege delegation
- [Native dispatch](./guides/native-dispatch.md) — connect an existing framework or library dispatcher directly
- [Inspect and invoke a Binding in the browser](./guides/interaction-inspector.md) — browser inspector UI over a selected Binding
- [Embed Boundary in a native C or C++ host](./guides/native-embedding.md) — C ABI via `boundary-ffi`
- [Use Boundary locally](./guides/local-consumers.md) — pack, vendor, and verify a local snapshot
- [Read Yjs and Automerge snapshots (experimental)](./guides/crdt-snapshots.md) — isolated read-only CRDT projections

## 3. Understand the model & its limits

- [What Boundary provides](./concepts/boundary.md) — clean ownership split between your app and Boundary
- [System map](./concepts/system-map.md) — end-to-end architecture from definitions to local/remote dispatch and Control
- [Guarantees and counterexamples](./concepts/guarantees.md) — exactly what Boundary checks, and what your tests must still prove
- [Testing the seams](./guides/testing.md) — quality ladder and `@foxworth/boundary/testing` contract-verification harnesses
- [Causal execution evidence](./reference/execution-evidence.md) — structured evidence records
- [Related work](./concepts/related-work.md) — algebraic effects, OpenAPI/Smithy, object capabilities, and durable execution
- [Glossary](./glossary.md) — crisp definitions mapped to exact APIs

## Native application guides

- [Next server reads and actions](./guides/next-native.md)
- [Next ticket triage and creative studio](./guides/next-domains.md)
- [Persistent Bun bot](./guides/persistent-bot.md)
- [Headless interaction stores and React hooks](./guides/headless-interactions.md)
- [Hono middleware and Worker invocation context](./guides/hono-workers-native.md)
- [Vite host replacement and cleanup](./guides/vite-native.md)
- [Application-owned Durable Objects](./guides/durable-objects-native.md)
- [Trusted Electron IPC](./guides/electron-native.md)

## Package reference

Import the subpath that owns the capability you need. Ordinary TypeScript integration starts with `@foxworth/boundary` (zero runtime dependencies); frameworks can lower their own declarations through the same lifecycle.

| Import | Job | Reference |
| --- | --- | --- |
| `@foxworth/boundary` | Definitions, `b.*` schemas, compilation, projections, installations, bindings, callers, `createHost`, `createBindingSlot` | [Host](./reference/host.md) |
| `@foxworth/boundary/program` | Portable contracts, identity digests, compatibility diffs, `b.*` schema builder | [Program](./reference/program.md) |
| `@foxworth/boundary/plan` | Handler-free multi-step Plans, minimal Projections, parallel waves, atomic preflight | [Plans spec](./spec/07-plans.md) |
| `@foxworth/boundary/testing` | Deterministic test adapters and contract-verification harnesses | [Testing](./guides/testing.md) |
| `@foxworth/boundary/build` | Explicit loading and build-time artifact generation | [Build](./reference/build.md) |
| `@foxworth/boundary/artifact` | Node-only verification and supplied artifact comparison | [Artifacts](./reference/artifact.md) |
| `@foxworth/boundary/drafts` | Propose, accept, and reject Drafts over a host-supplied store | [Host](./reference/host.md) |
| `@foxworth/boundary/observations` | Capture and validate point/query evidence for host read reuse | [Observed reads](./reference/observations.md) |
| `@foxworth/boundary/handoff` | Checked invocations across process seams | [Handoff](./reference/handoff.md) |
| `@foxworth/boundary/client` | Remote clients, reactive reads, cache scopes, and remote error types | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/control` and `@foxworth/boundary/control/host` | Controlled effects (proposals, grants, leases, reconciliation) and their Host bridge | [Control](./reference/control.md) |
| `@foxworth/boundary/http` | HTTP handlers, OpenAPI, SSE observations, and clients | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/mcp` and `@foxworth/boundary/webmcp` | Agent and browser tool adapters | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/inspector` | Browser inspection and explicit invocation of a selected Binding | [Interaction inspector](./guides/interaction-inspector.md) |
| `@foxworth/boundary/react` and `@foxworth/boundary/react/styles.css` | React hooks, cache invalidation, and optional styles | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/cloudflare` and `@foxworth/boundary/electron` | Platform integrations | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/yjs` and `@foxworth/boundary/automerge` | **Experimental** local CRDT snapshot capture and JSON projection | [CRDT snapshots](./guides/crdt-snapshots.md) |
| `@foxworth/boundary/plugin` | WIT projection, WASM plugin inspection, and loading | [Plugins](./reference/plugin.md) |
| `@foxworth/boundary/reach` and `@foxworth/boundary/bus` | Reach records and the local bus client | [Reach](./reference/reach.md) |

The [Rust reference](./reference/rust.md) covers the independent native Rust crate (`boundary-core`). The [normative specification](./spec/README.md) defines exact cross-language laws and conformance vectors.

The [SDK README](../packages/README.md#subpath-ownership) maps every subpath to its source module.
