---
title: "Who Boundary is for"
description: "When an application interaction outlives its first caller, realization, or execution path."
---

# Who Boundary is for

Boundary is for engineers who expect a meaningful application interaction to outlive
its first caller, realization, or execution path.

> **Current status:** The ordinary `@foxworth/boundary` workflow described here is
> implemented in this workspace. Program, Handoff, Control, and adapter
> packages remain directly available lower-level capabilities.

## 1. Framework, runtime, and domain-library authors

This is the first public audience. A framework can keep its native interaction
syntax and provide one lowering Adapter plus native dispatch integration. Boundary
then derives deterministic Programs, caller Projections, live Installations,
atomic Bindings, and portable manifests without taking over application policy,
state, or execution.

Application authors continue to use the framework's natural models, interactions,
routes, tools, or sessions. They should not need to understand Program,
Catalog, Handoff, or serialized intent.

See the [adapter reference](../reference/adapters.md) and the
[native application guides](../README.md#native-application-guides).

## 2. Platform and protocol Adapter authors

Platform teams often see one action redefined across an operator UI, HTTP API,
CLI, desktop channel, worker, and agent tool. A Projection gives each caller an
explicit exact expected surface; a Binding gives serving Adapters only the
selected live capability they need.

Documentation and build Adapters can consume a portable Projection without any
Installation. Serving Adapters consume a Binding or Binding manifest. They do
not receive the whole host dispatcher or infer policy from visibility.

See [adding a caller](../guides/adding-a-caller.md).

## 3. Bare TypeScript library and application authors

When no framework owns interaction authoring, `defineInteraction` supplies a small
first-party path. Authors assemble definitions in a plain record, compile them,
project caller surfaces, pair them with exact implementations, install them,
and bind explicitly.

The library remains host-neutral: it does not own models, state, policy,
transactions, lifecycle, deployment, jobs, or workflows.

See the [thumbnail walkthrough](../guides/getting-started.md).

## Other strong fits

- [Add a caller](../guides/adding-a-caller.md) when native interactions already
  exist behind a dispatcher.
- [Controlled effects](../guides/controlled-effects.md) when publish, deploy,
  delete, charge, or mutate needs explicit authority and recovery truth.

## The fit test

Ask: **must this interaction's identity survive a change in caller, realization,
execution path, deployment, review, package, process, language, or recovery?**

If yes, an interaction contract may be worth making explicit. If the work is a
private helper with one disposable caller and realization, an ordinary function
is probably enough.

Continue with the [TypeScript guide](../guides/getting-started.md).
