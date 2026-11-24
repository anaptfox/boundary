---
title: "Boundary specification"
description: "Observable laws that every Boundary host and caller must conserve."
---

# Boundary specification

**Status:** Current normative specification.

This specification states observable Boundary laws. It does not define an
application framework, universal computing model, transport, package manager,
or proof that a host implementation is correct.

Normative words such as **MUST**, **MUST NOT**, and **MAY** describe
conformance.

## Reading order

1. [Model and laws](./01-model-and-laws.md)
2. [Contracts and identity](./02-contracts-and-identity.md)
3. [Control and recovery](./03-control-and-recovery.md)
4. [Projections, Bindings, Handoffs, and conformance](./04-projections-handoffs-and-conformance.md)
5. [Host authoring and artifacts](./05-host-authoring-and-artifacts.md)
6. [HTTP framing for version 1 Handoff](./06-http-framing.md)
7. [Plans](./07-plans.md)

The [Host](../reference/host.md),
[Host build](../reference/build.md),
[Program](../reference/program.md), [Handoff](../reference/handoff.md), and
[Control](../reference/control.md) references define the TypeScript-facing
interfaces. This specification is authoritative when explanatory prose and
implementation behavior disagree.

## Version boundary

Artifact and wire versions are separate:

- interaction-contract, Program, and Draft artifacts use version 1;
- Installation and Projection artifacts use version 1; and
- ProjectionBinding manifests, Handoff invocations, Handoff outcomes, and
  Control durable records use version 1.

Handoff remains transport-neutral. A host MAY carry it over any transport;
[section 6](./06-http-framing.md) specifies one HTTP framing so independently
authored hosts and clients interoperate, and binds only a host that claims it.

Version 1 is the only public artifact, Handoff, and Control record version.
Unknown or future versions are rejected. Structural contract compatibility
inside an atomic Binding remains a current law and retains both expected and
actual identities.

## Normative boundary

Boundary specifies portable contracts, Programs, explicit Projections, live
Installations, atomic Bindings, Handoffs, direct and request modes, controlled
authority and recovery, generated artifacts, package artifacts, and conformance.
A conforming host may keep any native framework, dispatcher, policy, stores,
transactions, credentials, and lifecycle.

## Conformance boundary

Passing conformance vectors means the identity, validation, selection,
Installation, Binding, Handoff, controlled-effect, recovery, and
package-integrity laws were observed for those vectors. It does not certify
domain logic, policy quality, semantic equivalence, infrastructure behavior,
deployment liveness, or production readiness.
