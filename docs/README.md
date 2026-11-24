---
title: "Learn Boundary"
description: "Walk from a thumbnail button through callers, plugins, and controlled effects on one application."
---

# Learn Boundary

Start with a thumbnail button. Add a script, change the implementation, and
predict which connections should still work. Then give an agent a smaller
surface over the same application.

## Follow the example

1. [Why interactions?](./concepts/interaction-first-programming.md) — see what stays fixed as callers and implementations change.
2. [Build the thumbnail tool](./guides/getting-started.md) — run it, replace an implementation, and deliberately break the contract. Add an agent last.
3. [Add another caller](./guides/adding-a-caller.md) — choose its surface and understand the transport seam.
4. [Load a plugin](./guides/plugins.md) — realize `images.makeThumbnail` in a component and see the host refuse an import it did not provide.
5. [Handle consequential effects](./guides/controlled-effects.md) — separate a request from execution and recover when the outcome is uncertain.

[Availability and support](./concepts/current-status.md) records current package
and implementation status. [Check whether Boundary fits](./concepts/audience.md) if
you already know the audience and job.

## Bring your own application

- [Concise native TypeScript authoring](./guides/concise-authoring.md) — the shortest TypeScript entry
- [Compose native modules](./guides/module-composition.md)
- [Native dispatch](./guides/native-dispatch.md) — select, inspect and coordinate a library's own dispatcher
- [Embed Boundary in a native C or C++ host](./guides/native-embedding.md)
- [Inspect and invoke a Binding in the browser](./guides/interaction-inspector.md)
- [Use Boundary locally](./guides/local-consumers.md) — install a packed snapshot and verify it
- [Read Yjs and Automerge snapshots (experimental)](./guides/crdt-snapshots.md)
- [Let humans and agents share application work](./guides/humans-and-agents.md)

## Understand and verify

- [What Boundary owns](./concepts/boundary.md)
- [System map](./concepts/system-map.md)
- [Guarantees and counterexamples](./concepts/guarantees.md)
- [Portable schemas](./guides/portable-schemas.md)
- [Testing the seams](./guides/testing.md)
- [Causal execution evidence](./reference/execution-evidence.md)
- [Related work](./concepts/related-work.md)
- [Glossary](./glossary.md)

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

Import the capability owner directly. Ordinary TypeScript integration begins
with `@foxworth/boundary`; existing frameworks can lower their own declarations.

| Import | Job | Reference |
| --- | --- | --- |
| `@foxworth/boundary` | Definitions, compilation, installations, projections, bindings, callers | [Host](./reference/host.md) |
| `@foxworth/boundary/build` | Explicit loading and artifact generation | [Build](./reference/build.md) |
| `@foxworth/boundary/artifact` | Node-only verification and supplied artifact comparison | [Artifacts](./reference/artifact.md) |
| `@foxworth/boundary/drafts` | Propose, accept, and reject Drafts over a host-supplied store | [Host](./reference/host.md) |
| `@foxworth/boundary/program` | Portable contracts, identity, compatibility | [Program](./reference/program.md) |
| `@foxworth/boundary/plan` | Validate plans and derive required projections | [Host](./reference/host.md) |
| `@foxworth/boundary/testing` | Deterministic test adapters and contract-verification harnesses | [Testing](./guides/testing.md) |
| `@foxworth/boundary/observations` | Capture and validate point/query evidence for host read reuse | [Observed reads](./reference/observations.md) |
| `@foxworth/boundary/handoff` | Checked invocations across process seams | [Handoff](./reference/handoff.md) |
| `@foxworth/boundary/client` and `@foxworth/boundary/handoff` | Remote errors, Binding resolution and result envelopes for adapters | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/control` and `@foxworth/boundary/control/host` | Controlled effects and their Host contribution | [Control](./reference/control.md) |
| `@foxworth/boundary/http` | HTTP, clients, and interface projections | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/mcp` and `@foxworth/boundary/webmcp` | Agent and browser tools | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/inspector` | Browser inspection and explicit invocation of a selected Binding | [Interaction inspector](./guides/interaction-inspector.md) |
| `@foxworth/boundary/react` and `@foxworth/boundary/react/styles.css` | React calls, invalidation, and optional styles | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/cloudflare` and `@foxworth/boundary/electron` | Platform integration | [Adapters](./reference/adapters.md) |
| `@foxworth/boundary/yjs` and `@foxworth/boundary/automerge` | **Experimental** local CRDT snapshot capture and JSON projection | [CRDT snapshots](./guides/crdt-snapshots.md) |
| `@foxworth/boundary/plugin` | WIT projection, plugin inspection, and loading | [Plugins](./reference/plugin.md) |
| `@foxworth/boundary/reach` and `@foxworth/boundary/bus` | Reach records and the local bus client | [Reach](./reference/reach.md) |

The [Rust reference](./reference/rust.md) describes the independent native
implementation. The [normative specification](./spec/README.md) defines exact
laws and the scope of shared conformance evidence.

The [SDK README](../packages/README.md#subpath-ownership) maps every subpath to its
source module.
