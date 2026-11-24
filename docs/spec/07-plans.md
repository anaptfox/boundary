---
title: "7. Plans"
description: "Portable handler-free plans, identity, static analysis, and atomic preflight."
---

# 7. Plans

**Status:** Current and normative.

## Plan artifact

A Plan is a handler-free, immutable description of symbolic interaction steps.
It MUST contain `version: 1`, a stable plan `id`, and at least one step. A step
MUST name a unique step ID, a projection alias that identifies one interaction,
an interaction ID, a `direct` or `request` mode, explicit named input bindings,
and optional ordering dependencies. Repeated steps MAY reuse an alias only for
the same interaction; their requested modes combine. Bindings are `literal`,
`plan-input`, or `step-output`; a step-output binding also creates a dependency
edge. Plans MUST NOT contain
handlers, credentials, policy, transport, or executable workflow logic.

`boundary.plan/v1` hashes the canonical JSON object containing `version`, `id`,
and normalized `steps`, prefixed by the domain and a NUL byte. Steps and
dependencies MUST be normalized deterministically before hashing. The resulting
`planDigest` is a lowercase `sha256:` digest. A consumer MUST reject a supplied
digest that does not match the normalized Plan.

## Analysis and preflight

The combined explicit and step-output dependency graph MUST be acyclic. A Plan
MUST derive the minimal Projection required by its aliases, interaction IDs, and
modes; repeated requirements for one alias merge their modes, and unrelated
Program interactions MUST be excluded.

Aggregate footprints are the sorted, duplicate-free union of the declared
reads and changes for all steps. Parallel waves MUST respect dependency edges
and separate steps whose read/write footprints conflict. Wave membership is a
deterministic analysis result; it does not execute the Plan or authorize
parallel execution by itself.

Before execution, a host MUST preflight the entire Plan against the selected
Program and one complete Binding. It MUST report all detectable missing
interactions, alias or mode mismatches, and contract incompatibilities before
any step begins. A failed preflight MUST be atomic: no step may have started.

Reviewed digest, analysis, and rejection cases live in
`tests/conformance/v1/plan.json`. These vectors establish shared value laws,
not workflow runtime behavior or proof that declared footprints are truthful.
