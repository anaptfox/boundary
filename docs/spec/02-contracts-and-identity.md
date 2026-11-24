---
title: "2. Contracts and identity"
description: "Interaction contract contents and how identity derives from portable declarations."
---

# 2. Contracts and identity

**Status:** Current and normative.

## Interaction contract

An interaction contract MUST contain exactly:

```ts
type InteractionContract = {
  version: 1;
  id: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errorSchema?: JsonSchema; // validates the complete { code, details } value
  reads: readonly string[];
  changes: readonly string[];
};
```

An externally supplied ID MUST match
`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`, remain opaque, and be preserved
byte-for-byte. Boundary MUST NOT prepend a package, caller, transport, or library
namespace.

Footprints MUST be own enumerable data-property arrays of non-empty strings.
Accessors, arbitrary iterables, sparse arrays, hidden fields, extra properties,
and non-string entries MUST be rejected. Values MUST be de-duplicated and sorted
by unsigned UTF-8 byte order. Both `reads` and `changes` enter identity.

Schemas and annotations MUST be portable JSON. Runtime behavior that cannot be
represented faithfully MUST fail compilation rather than emit a weaker
contract.

## Contract and Program identity

`boundary.interaction-contract/v1` hashes `version`, `id`, input, output, optional
declared error, `reads`, and `changes`. Handlers, policies, docs, annotations,
routes, tools, paths, Installation and Realization IDs, and execution modes MUST
NOT alter it.

`boundary.program/v1` hashes interaction contract identities sorted by interaction ID.
Duplicate IDs MUST be rejected. A Program MUST remain handler-free and portable.

## Structural compatibility

`contractCompatibility(expected, actual)` is compatible exactly when IDs match,
actual input accepts every expected input, expected output accepts every actual
output, expected declared-error schema accepts every actual declared error, and
the actual `reads` and `changes` footprints are each a subset of the expected
ones. Footprints are directional: an implementation MAY touch less than the
caller was told to expect and MUST NOT touch more. Reviewed cases live in
`tests/conformance/v1/contract-compatibility.json`.

## Scoped footprints

A footprint MAY declare a parameterized resource using `{input.<path>}`, where
`<path>` is a dot-separated path into the interaction input. A static footprint
template subsumes a concrete resource when its literal segments match and each
placeholder matches exactly the corresponding path value; compatibility MUST
compare these templates directionally and MUST NOT treat a more general actual
footprint as compatible with a narrower expected footprint. At invocation time,
the host MUST resolve each placeholder deterministically from the validated
input before applying the interaction. String, number, and boolean path values
are converted to text. If a path cannot be resolved to one of those scalar
values, resolution MUST use the template's coarse resource prefix when present;
otherwise it MUST retain the original template. Reviewed cases live in
`tests/conformance/v1/scoped-footprints.json`.

## Optional algebraic traits

A contract MAY declare `idempotencyKey` and `compensates` traits. These are
declarations of intended algebraic behavior, not proofs that an implementation
is idempotent or that compensation restores prior state. When absent, each trait
MUST be omitted from version 1 canonical contract JSON. Compatibility is
directional: an actual contract MUST preserve every trait required by the
expected contract, while adding a trait does not make a narrower expected
contract incompatible. Reviewed cases live in
`tests/conformance/v1/contract-traits.json`.

An atomic Binding MAY use that judgment. When it does, it MUST pin both expected
and actual Programs and contract digests. It MUST NOT relabel the actual
realization as the expected contract or use compatibility outside the complete
Binding check.

All Handoff manifests, invocations, and outcomes are version 1.

## Installation identity

`InstallationId` and `RealizationId` MUST be opaque validated host-issued
strings. An Installation ID is stable for one logical deployment and MUST never
be reused. A Realization ID is exact for one `(interactionId, mode)` and MUST
change when that realization changes. Direct and request modes MUST use distinct
Realization IDs.

An Installation manifest contains its host ID, Program, exact Catalog, and
`installationDigest`. `boundary.installation/v1` hashes the artifact schema version,
Program, and Catalog, excluding the host-issued Installation ID and all live or
private implementation data.

## Projection identity

A Projection artifact contains the expected selected-subset Program, explicit
arity, and a non-empty set of direct/request modes for every selection.
Definition-record aliases are local and MUST normalize away from portable
identity. Caller-facing Projection aliases are durable: they MUST be unique,
serialized, and included in `boundary.projection/v1` together with the artifact
schema version, selected Program, interaction identity, arity, and modes. Renaming
a Projection alias therefore changes Projection identity. Projection identity
MUST exclude Installation, Catalog, availability, admission, context, and
liveness.

## Binding identity

A version 1 Binding manifest pins `projectionDigest`, `installationId`,
`installationDigest`, expected and actual Programs and contracts, durable
caller alias, interaction ID, mode, arity, Realization ID, and request
preview/control identity where present. Canonical entries are keyed by
`(alias, mode)`. `boundary.projection-binding/v1` hashes that canonical data
excluding `bindingDigest`.

A Binding digest identifies one recorded conjunction. It does not prove that a
live Binding still exists. Revocation and reinstallation MUST NOT silently
change a previously issued manifest.

## Catalog

A Catalog MUST name one exact Program and provide one entry for every Program
interaction. Each present direct or request mode MUST name its Realization ID.
Request entries MUST additionally pin control identity and public-preview
schema. Missing, duplicate, unknown, or inconsistent entries MUST be rejected.
Catalog availability MUST NOT alter Program identity.

## Draft identity

A Draft is an inert artifact proposing one full interaction contract that does not
yet exist. It MUST wrap a complete `InteractionContract`, never a fragment, plus
`gap`, an opaque host-supplied `proposer`, and a host-supplied `createdAt`. It
MUST NOT enter a Program and MUST NOT be callable. Accepting a Draft still
requires an ordinary host declaration.

`boundary.interaction-draft/v1` hashes `version`, the contract's own identity value,
`gap`, `proposer`, and `createdAt`. Boundary MUST NOT read a clock; `createdAt` is
host-supplied and shape-checked. Reviewed cases live in
`tests/conformance/v1/draft.json`.
