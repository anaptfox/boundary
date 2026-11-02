---
title: "Availability and support"
description: "Current package and implementation status across TypeScript and Rust."
---

# Availability and support

Boundary is available in this workspace. The TypeScript SDK and Rust crates are
not yet published. The examples in this repository are the current way to try
the interfaces; an installation command in a guide names the intended package.

## Experimental integrations

**Experimental** means available for evaluation, with APIs that may change
incompatibly and no production support commitment. Passing tests establishes
only the behavior exercised; it does not promote an integration out of this
status. Pin the exact package snapshot when evaluating these APIs.

| Integration | Status | Available evidence |
| --- | --- | --- |
| `@foxworth/boundary/yjs` | Experimental | Local snapshot capture and JSON projection; focused tests and a packed-consumer loopback example |
| `@foxworth/boundary/automerge` | Experimental | Local snapshot capture and JSON projection; focused tests and a packed-consumer loopback example |

These labels describe Boundary's adapters, not the upstream CRDT engines.
See the [experimental snapshot guide](../guides/crdt-snapshots.md) for API and
evidence limits. A change in maturity requires an explicit readiness review;
an exported subpath or a successful e2e run alone does not establish it.

## TypeScript

`@foxworth/boundary` provides interaction definitions, deterministic compilation,
portable Surfaces, native implementations, live Installations, atomic
Binding, per-call context, and host-held revocation. Its optional Control
bridge creates requests for consequential effects.

The TypeScript root's short path is `surface`, `install`, and `connect`. It
composes the explicit pipeline (`@foxworth/boundary/pipeline`) and returns the
same compiled, installed, projected, and bound artifacts with one method per
selected interaction and a `propose` method per request-mode selection. It does
not change portable contracts or add Rust support; the [host reference](../reference/host.md#the-short-path)
shows it on an in-memory scene.

The experimental `@foxworth/boundary/yjs` and `@foxworth/boundary/automerge`
subpaths capture local document versions and provide isolated JSON projections. They do
not implement synchronization, persistence, candidate storage, or application
policy. The [CRDT snapshot guide](../guides/crdt-snapshots.md) describes the
adapter boundaries and a loopback replica example; this is not a claim of a
general network provider or browser integration.

Program, Handoff, and Control are also available as core subpaths.
Adapters cover HTTP, MCP, WebMCP, React, tRPC, Vite, Next, Hono, Cloudflare, and
Electron. `@foxworth/boundary/drafts` is a Host subpath in that same family.
`@foxworth/boundary/plugin`, `@foxworth/boundary/reach`, and `@foxworth/boundary/bus` are
first-class subpaths in the same npm candidate. See the
[package map](../README.md#package-reference) and
[adapter reference](../reference/adapters.md).

The older Todo fixture remains an executable lifecycle regression example:

<!-- snippet:examples/snippets/typescript/host-lifecycle.ts#foundation-status -->
```ts
export const hostLifecycleExampleStatus = {
  interface: "host-lifecycle",
  package: "@foxworth/boundary",
  workspaceAvailable: true,
  published: false,
} as const;
```

The [thumbnail walkthrough](../guides/getting-started.md) is the first learning
path. Its local fixture establishes the behaviors exercised by its tests,
including incompatible binding and caller selection. It does not establish
remote rendering, deployment availability, or image quality in production.

## Framework and interaction coverage

The generic framework mounts remain available alongside native interfaces for
[Next server calls](../guides/next-native.md),
[Hono/Worker context](../guides/hono-workers-native.md),
[Vite generation lifecycle](../guides/vite-native.md), and
[Electron IPC trust](../guides/electron-native.md). Durable Objects retain
[application-owned class and storage composition](../guides/durable-objects-native.md).
These are library integrations, not complete framework application runtimes.

Local native smoke runs exercise Next's default production build and real
Server Action and MCP-to-human publication review, Worker service-binding Handoff,
Durable Object SQLite reconstruction, platform-delivered alarm reconciliation
and workspace WebSocket reconnect, Vite development/preview reload and cleanup,
and the actual sandboxed
Electron IPC bridge. They use built package artifacts and deterministic
application fixtures. They do not establish production authentication or
distributed application storage. Folio publication
and the Bun bot additionally have process-death/restart proofs against durable
local data; those do not certify every application effect or hosting topology.

Framework-neutral reactive reads, explicit invocation/proposal stores and React
hooks are available. Applications compose their own UI and authorized public
status/review paths; generic callback types do not establish authorization or
redact data. Next cache behavior remains explicitly host-supplied rather than
automatic. Persistent bots and chat/task scheduling remain responsibilities of
the application and its chosen runtime.

The bounded example suite is present: the
[document workspace](../guides/next-native.md),
[ticket triage and creative studio](../guides/next-domains.md), and a
[persistent Bun bot](../guides/persistent-bot.md). They use persisted local
application data and complete human paths. The document workspace is the
selected cross-entry spine for the in-app assistant, external MCP and optional
WebMCP. Triage's
investigators are deterministic local functions, not an external model service;
the bot's optional Ollama adapter remains separately approval-gated. No suite
example is a production multi-user authentication or distributed-runtime claim.

The packed portable consumer has been exercised locally on Node 24.20.0 and
Bun 1.3.14. It checks generated-reference types and executes
Program/Host/Handoff calls, client/cache/headless interaction, and the Control
replay/uncertainty fixture. The Control fixture uses a memory journal, not durable
application storage. The browser client/store/React bundle check excludes
host installation and Control administration; it does not prove browser UI
behavior.

This is not a claim that every package subpath or framework runs on all three
runtimes. Bun is the selected runtime for the persistent-bot example
only. Framework/build tools keep their native runtime requirements; contributor
versions are pinned by the repository.

Existing framework smoke tests, local socket tests and injected Electron API
tests establish only the paths they exercise. Injected Electron APIs do not
establish real desktop-runtime behavior, and a Fetch response does not prove
durable recovery or a complete native application. See
[testing](../guides/testing.md) for the current quality ladder.

## Rust

Rust is an independent native implementation and does not execute TypeScript.
It offers executor-neutral interaction and lifecycle interfaces, borrowed
per-call context, and a separate Control Module. It is unpublished and is not
part of the npm release. See the [Rust reference](../reference/rust.md).

Shared conformance vectors establish the particular laws they exercise.
They do not establish feature parity or behavioral equivalence between hosts.

## Evidence and release

Executable examples, focused tests, shared conformance, package verification,
and live acceptance establish different facts. Consult the CI result for the
exact revision being evaluated; this page does not certify the current working
tree or an unpublished release candidate.

The repository contains candidate-building and maintainer publication tooling.
Publication and deployed behavior require their own evidence. See
[guarantees and counterexamples](./guarantees.md) before relying on a contract
identity as evidence of application correctness.
