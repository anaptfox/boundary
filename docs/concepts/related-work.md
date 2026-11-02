---
title: "Related work"
description: "How Boundary sits next to interaction meaning, portable contracts, authority, and failure truth."
---

# Related work

Boundary sits near four established families. Each makes a different concern
explicit: interaction meaning, portable contracts, authority, or failure truth.

> **Current status:** The Host lifecycle used in the comparisons is implemented
> in this workspace. Program, Handoff, and Control remain current lower-level
> mechanisms.

## The short map

| Neighbor | What it centers | Where Boundary overlaps | Where Boundary differs |
| --- | --- | --- | --- |
| [Algebraic effects and handlers](https://homepages.inf.ed.ac.uk/gdp/publications/handling-algebraic-effects.pdf) | an interaction separated from its interpreter | one interaction may outlive one realization | Boundary uses inspectable application contracts across caller, deployment, and process seams; it is not a language effect system |
| [Smithy](https://smithy.io/2.0/spec/service-types.html#interaction) and [OpenAPI](https://spec.openapis.org/oas/v3.1.1.html#interaction-object) | portable service or HTTP contracts | named interactions and schemas can produce concrete interfaces | Boundary begins with the application-owned interaction before choosing HTTP, MCP, UI, or another caller interface |
| [Object-capability systems](https://www.erights.org/talks/thesis/markm-thesis.pdf) | explicit authority that can be narrowed | callers should receive no more capability than needed | Projection selects and Binding attenuates a live surface, but host admission still evaluates each call |
| [Temporal](https://docs.temporal.io/temporal) and [Restate](https://docs.restate.dev/foundations/key-concepts) | durable execution and recovery | consequential effects need stronger truth than a returned promise | Boundary keeps Control optional and leaves journals, execution, verification, and reconciliation with the host |

## Algebraic effects: interaction apart from realization

Algebraic effects separate an interaction from the handler that interprets it.
Boundary applies a related idea at an application integration seam:

```text
todos.complete contract
        -> local implementation
        -> framework-native dispatcher
        -> later packaged realization
```

The portable definition and Projection contain no handler. Installation binds
one live realization later. The analogy stops there: Boundary is not a language
effect system, and declared `reads` and `changes` are not inferred effect rows.

## Smithy and OpenAPI: make contracts tangible

Smithy gives service interactions explicit inputs, outputs, and errors. OpenAPI
makes HTTP interactions inspectable by people and tools. Boundary keeps a stable
application interaction before selecting a transport:

```text
todos.complete
      |
      +-> HTTP interaction
      +-> MCP tool
      +-> screen action
      +-> direct host call
```

An OpenAPI `interactionId`, route, or Smithy shape can be an excellent interface
identity. Boundary does not replace it. A projector derives that interface from a
Projection or Binding manifest and returns checked invocation to the host.

## Capabilities: selection and authority are different

```text
screen Projection: complete + clear
agent Projection:  complete

agent -> clear -> absent from its bound surface
```

Capability systems call this narrowing *attenuation*. Boundary keeps three facts
separate:

- Program declaration says an interaction exists;
- Projection says a caller surface may ever call it;
- Binding plus per-invocation admission makes one checked live path available.

A tool list or page presents the whole Binding. There is no softer layer that
shows a subset: the Projection is the only narrowing, because it is the one
that is enforced.

None is an organization-wide IAM system or proof that policy is correct.

## Temporal and Restate: failure changes knowledge

Durable-execution systems record progress so work can recover across process,
machine, or network failure. Boundary starts with direct execution and an honest
`unknown` outcome when a call may have started but lacks durable evidence.

Consequential effects can use Control:

```text
request -> approve -> grant -> attempt -> apply -> verify -> receipt
                                      |
                            process or network breaks
                                      |
                                  uncertain
                                      |
                                  reconcile
```

Temporal and Restate provide broader execution runtimes. Boundary Control is a
narrow optional lifecycle around the same application interaction contract. The
host supplies durable storage, policy, effect code, verification, and
reconciliation.

These ingredients are established. Boundary combines them around one job: conserve
the application-owned interaction while caller surfaces and realizations change.
