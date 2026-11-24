---
title: "Who Boundary is for"
description: "When an application interaction needs to outlive its first caller, implementation, or deployment."
---

# Who Boundary is for

Boundary is for teams whose meaningful application actions will outlive their first caller, implementation, or runtime.

## The fit test

Ask one question about an action:

> **Does this action's contract need to survive a change in caller, implementation, process, language, review flow, or deployment?**

- **Yes** (a UI + CLI + AI agent, a plugin seam, a worker split, a human-reviewed mutation) → make it an **Interaction**.
- **No** (a private helper whose caller and implementation always change together) → keep it an ordinary function.

## Three primary audiences

### 1. Application & library authors (TypeScript or Rust)

You want one source of truth for your application's capabilities—without marrying a heavy framework. Start with zero-dependency `b.*` schemas (or Zod), wire callers synchronously with `createHost`, get typed `caller.try.*` outcomes instead of untyped exceptions, and grow into Plans, HTTP/MCP adapters, or Control only where needed.

Start with [Build a thumbnail tool](../guides/getting-started.md) or [Concise native authoring](../guides/concise-authoring.md).

### 2. Platform, agent, and protocol adapter authors

You are tired of redefining the same action separately for a web UI, an HTTP API, a CLI, a desktop IPC bridge, and an MCP tool server. A **Projection** gives each caller an exact, narrow contract; a **Binding** gives each adapter only the live capability it was granted—never the full host dispatcher.

Start with [Add another caller](../guides/adding-a-caller.md) and [Humans and agents](../guides/humans-and-agents.md).

### 3. Framework and runtime authors

You already have great native authoring syntax and a native dispatcher. Lower your declarations into Boundary once to get deterministic Programs, caller Projections, atomic Bindings, portable manifests, and multi-caller adapters—without forcing your users to abandon your native API.

See the [adapter reference](../reference/adapters.md) and the [native application guides](../README.md#native-application-guides).

## Strongest problem fits

- **Human + AI agent workspaces** where both read and draft, while humans approve consequential changes ([Humans and agents](../guides/humans-and-agents.md)).
- **High-stakes side effects** (billing, publishing, deploys, deletions) that need explicit approval and honest uncertainty/reconciliation ([Controlled effects](../guides/controlled-effects.md)).
- **Multi-language hosts and plugins** where Rust, TypeScript, C/C++, or WASM components must agree on exact contracts ([Plugins](../guides/plugins.md), [Native embedding](../guides/native-embedding.md)).

---

**Next:** [Build the thumbnail example →](../guides/getting-started.md)
