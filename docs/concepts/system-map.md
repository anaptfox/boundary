---
title: "System map"
description: "The Host lifecycle from declarations through projection, binding, and dispatch."
---

# System map

> **Current status:** This map describes the implemented `@foxworth/boundary`
> lifecycle. Program, Handoff, Control, and existing projectors remain current
> lower-level Modules.

## Normal host path

```text
Application or framework
  native declarations + native dispatcher + policy + state
             |                     |
             | lower               | install exact bindings
             v                     v
      CompiledInteractions    InteractionInstallation
        Program + handles       Catalog + live identity
             |
             | project desired caller surface
             v
         Projection
             |
             +------------- bind atomically -------------+
                                                          v
                                                ProjectionBinding
                                                          |
                                                    stateless Caller
                                                          |
                                             context supplied per invocation
                                                          |
                                                  native dispatcher
```

The Projection and Installation are peers. Neither contains the other.
Projection is portable desired truth and may have zero realizations.
Installation is live available execution and may contain unrelated extras.
Binding pins one complete compatible conjunction or returns `unrealized`.
A tool list or page presents that whole Binding; there is no adapter-level
subset. A caller that must see less is bound to a narrower Projection.

## Bare TypeScript path

```text
plain record of defineInteraction values ---> compileInteractions
                 |
                 +------------------------> implementInteractions
                                                      |
CompiledInteractions + InteractionImplementations --------+
                              |
                       installInteractions
```

Definitions remain inert. Implementations are an immutable process-local
Adapter. Installation creates availability; it does not acquire policy, state,
framework lifecycle, or Control.

## Ownership

| Boundary represents and checks | The application authors and owns |
| --- | --- |
| portable contracts, Programs, and exact identities | interaction IDs, domain meaning, and native declarations |
| CompiledInteractions and inert handles | implementation behavior and application state |
| caller-specific Projections | caller purpose and which surfaces exist |
| Installation availability and realization pins | dispatch, runtime health, routing, replicas, and failover |
| atomic Binding and per-call admission seam | authentication, policy, actors, credentials, and capabilities |
| input, output, and declared-error validation | transactions, stores, external systems, and domain evidence |
| optional Control state-machine laws | journals, policy, apply, verification, and reconciliation implementations |

Selection is not authority. Availability is not permission. A manifest is not
a live capability. A matching digest is not proof of behavior.

## Package map

```text
normal integration
  @foxworth/boundary
  @foxworth/boundary/build
  @foxworth/boundary/drafts

core
  @foxworth/boundary/program
  @foxworth/boundary/handoff
  @foxworth/boundary/control

optional bridge
  @foxworth/boundary/control/host

caller and platform adapters
  @foxworth/boundary/client / @foxworth/boundary/http
  @foxworth/boundary/mcp / @foxworth/boundary/webmcp
  @foxworth/boundary/react
  @foxworth/boundary/frameworks/vite / next / hono
  @foxworth/boundary/cloudflare / @foxworth/boundary/electron

discovery and guests
  @foxworth/boundary/plugin
  @foxworth/boundary/reach / @foxworth/boundary/bus
```

Host does not re-export the core modules or adapters. The Control bridge is
owned by Control. Direct-only dependency graphs remain Control-free.

## Local and remote calls

```text
local:
  projected handle + input + context
       -> Caller -> Binding -> admission -> installed dispatcher

remote:
  transport bytes
       -> Handoff decode and conservation
       -> opaque checked invocation
       -> Binding.invoke
       -> installed dispatcher
```

Transports frame data; Handoff alone accepts untrusted serialized invocation.
Remote clients pin a Projection Binding manifest and explicitly re-handshake
after Installation replacement.

## Optional request path

```text
Caller.request
  -> validate
  -> admission
  -> plan
  -> Control request policy
  -> persist proposal

later under separate Control authority:
  approve -> grant -> attempt -> apply -> verify -> receipt
                                  |
                               uncertain -> reconcile
```

Request is a mode of the original interaction and never performs its effect.

Continue with [interaction-first programming](./interaction-first-programming.md),
[the integration guide](../guides/getting-started.md), or
[guarantees](./guarantees.md).
