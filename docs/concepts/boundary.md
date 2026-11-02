---
title: "What Boundary provides"
description: "Boundary gives applications an explicit, checked agreement between callers and the implementations of their interactions."
---

# What Boundary provides

Boundary gives applications an explicit, checked agreement between callers and the
implementations of their interactions.

In the [thumbnail example](./interaction-first-programming.md), the application
owns image processing. Boundary checks whether an installation can fulfill the
caller's declared thumbnail contract before connecting them.

## Where the boundary belongs

A shared function is often enough inside one application. Boundary becomes useful
when a caller's expectations need to be represented independently: a separately
built client, a native tool, a plugin, or an implementation deployed on another
schedule.

The contract describes the action without carrying executable handlers or
private authority. The live host supplies implementations and decides whether
each invocation is allowed.

| The application owns | Boundary provides |
| --- | --- |
| What making a thumbnail means | Portable declarations and derived identity |
| Image stores, processing code, and transactions | Validation of declared inputs, outputs, and errors |
| Authentication, credentials, and policy | An admission seam for each invocation |
| Which capabilities a caller should receive | Explicit caller selections and checked binding |
| Runtime health, transport, and deployment | Recorded installation and realization identities |
| Evidence that the thumbnail is correct | Reports of declared incompatibility |

The two sides stay independent until binding:

```text
application declarations             application implementations
           |                                      |
           v                                      v
        Program                              Installation
           |                                      |
           v                                      |
        Surface ────────── checked binding ────────┘
                                 |
                                 v
                              Caller
                                 |
                       host admission per call
                                 |
                       application execution
```

## Integrate at the level your application needs

Bare TypeScript can declare interactions and pair them with implementations using
`@foxworth/boundary`. A framework can retain its own authoring syntax and native
dispatcher, then lower its declarations into the same lifecycle.

The lower-level packages remain independently useful:

- **Program** represents portable contracts and their identity.
- **Handoff** checks untrusted serialized intent at a process boundary.
- **Control** represents proposals, authority, attempts, receipts, uncertainty,
  and reconciliation for consequential effects.

A direct interaction does not require Control. When the host chooses request
mode, requesting creates a proposal without executing the effect. Persistence,
policy, verification, and recovery remain host responsibilities.

## What adopting Boundary does not supply

Boundary does not provision workers, choose transports, schedule jobs, store domain
data, or make an application transactional. It does not automatically migrate
callers when an implementation changes.

A compatible declaration is not proof of equivalent behavior. The application
must still establish that an implementation does the intended work. Likewise,
a caller's selected surface is not a grant: host admission remains necessary.

These boundaries let an image library, an application framework, and a native
tool retain their own programming models while exposing checked interactions.

Read the [walkthrough](../guides/getting-started.md) to try the lifecycle,
[who Boundary is for](./audience.md) to choose an integration path, or
[current status](./current-status.md) for publication and support details.
