---
title: "Program reference"
description: "Portable contracts, identity, compatibility, and bounded schema validation."
---

# Program reference

`@foxworth/boundary/program` owns portable contracts, canonical identity, Programs,
Catalogs, compatibility, and bounded schema validation. It is a direct
foundation package. It contains no host implementations, caller context,
admission, Control authority, transport, or filesystem behavior.

## Interaction contract version 1

```ts
type InteractionContract = {
  version: 1;
  id: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errorSchema?: JsonSchema;
  reads: readonly string[];
  changes: readonly string[];
};
```

`boundary.interaction-contract/v1` hashes `version`, `id`, `inputSchema`,
`outputSchema`, optional `errorSchema`, `reads`, and `changes`. Both footprints
participate in identity and `contractCompatibility`. A reads-only change
therefore changes the contract and Program digests.

The ID is a host-authored opaque token and is preserved byte-for-byte. Valid
footprints are own enumerable data-property arrays of non-empty strings,
de-duplicated and sorted by unsigned UTF-8 byte order. Accessors, arbitrary
iterables, sparse arrays, extra array properties, hidden fields, and non-string
entries are rejected.

`InteractionDescriptor` places documentation and annotations beside the contract.
They remain outside `contractDigest`. A descriptor digest is not standardized.

## Program version 1

```ts
type Program = {
  version: 1;
  interactions: readonly InteractionDescriptor[];
  programDigest: `sha256:${string}`;
};
```

`boundary.program/v1` hashes the sorted interaction-contract identities. It excludes:

- implementations, handlers, stores, and schema-library objects;
- Installation and Realization IDs;
- policies, actors, grants, context, and control hooks;
- documentation and annotations;
- routes, tools, views, risk labels, and framework lifecycle;
- deployment availability and manual revisions.

Replacing implementation code or changing a route preserves Program identity.
Changing an interaction ID, contract-bearing schema, `reads`, or `changes` does
not.

## Compatibility

`contractCompatibility(expected, actual)` is a structural judgment on the
portable schema profile. Shared cases are
`tests/conformance/v1/contract-compatibility.json`. Compatibility requires:

- equal interaction IDs;
- actual input accepting every expected input;
- expected output accepting every actual output;
- expected declared-error schema accepting every actual declared error; and
- actual `reads` and `changes` footprints within the expected ones.

An additive optional output field can therefore be compatible, and so can an
implementation that reads or changes less than the caller expects. A renamed
field, type change, wider footprint, or interaction-ID change is incompatible.

The matcher is conservative. For a nonidentical `oneOf`, exactly one branch
must cover the offered schema, and declared types must rule out overlap with
every other branch. `number` and `integer` overlap; an unproved exclusion is
rejected. Identical schemas remain compatible at every nesting depth.

Compatibility permits an atomic Binding to pin a caller's expected contract to
a distinct actual contract. It never erases either identity. The version 1
Binding manifest, invocation, and outcome carry both expected and actual
contract digests. Durable Control records pin the actual Installation and
Realization identities used for execution.

Compatibility never erases identity or changes the Handoff wire version. The
public wire protocol is version 1 only.

### Explaining a contract change

`contractChanges(before, after)` reports which declared values changed and whether
existing callers remain compatible:

```ts
import { contractChanges } from "@foxworth/boundary/program";

const delta = contractChanges(before, after);
// delta.changes: { path, kind, before?, after? }[]
// delta.existingCallers: the existing contractCompatibility judgment
```

`ContractDelta.changes` contains `added`, `removed`, or `changed` entries in path
order, with immutable snapshots of the old and new JSON values when present.
Contracts are normalized first, so footprint reordering and duplicates do not
produce changes. Objects are compared by key; arrays are reported as whole values.

Paths such as `outputSchema.properties.reply_url` are display labels. Literal
periods in property names can make them ambiguous; they are not addresses or
patch instructions. `existingCallers` is exactly
`contractCompatibility(normalizedBefore, normalizedAfter)`, with the old contract
expected and the new one offered.

The native Rust equivalent is `contract_changes`. Both are declaration review
aids for upgrade reports, review screens, or agent explanations. They have no
wire schema, identity, or shared portable output guarantee, and say nothing about
realization behavior. The host still owns acceptance and execution; Binding
performs its compatibility check.

## Catalog

A Catalog is a handler-free deployment overlay for one exact Program. Every
Program interaction has one entry; each mode is either absent or names its exact
available realization.

```ts
type CatalogEntry = {
  interactionId: string;
  direct?: {
    realizationId: RealizationId;
  };
  request?: {
    realizationId: RealizationId;
    controlDigest: Sha256Digest;
    previewSchema: JsonSchema;
  };
};

type Catalog = {
  version: 1;
  programDigest: Sha256Digest;
  interactions: readonly CatalogEntry[];
};
```

`RealizationId` is an opaque validated host-issued string exact for one
`(interactionId, mode)` realization. Direct and request identities are distinct.
A Catalog rejects duplicate, missing, unknown, or contract-inconsistent
entries. Availability and realization identity do not change Program identity.

Request availability is contributed only through `@foxworth/boundary/control/host` and
includes the public-preview schema and exact control identity. A Catalog cannot
grant approval, execution, or administrative Control authority.

## Installation manifest

An `InstallationManifest` is the data-only description of a live
`InteractionInstallation`:

```ts
type InstallationManifest = {
  version: 1;
  installationId: InstallationId;
  installationDigest: Sha256Digest;
  program: Program;
  catalog: Catalog;
};
```

`InstallationId` is an opaque validated host-issued string, stable for one
logical deployment and never reused. `boundary.installation/v1` hashes the artifact
schema version, Program, and Catalog; it excludes `installationId`, handlers,
policy, context, liveness, and private targets.

The ID answers “which logical live deployment was selected?” The digest answers
“which declared Program and availability artifact was presented?” Neither
proves implementation correctness. An Installation manifest is produced only
from a live Installation, never from build configuration alone.

## Public utilities

`@foxworth/boundary/program` exports:

- the JSON primitives below;
- `portableSchema<Value>()` and bounded JSON Schema value validation
  (`validateSchemaValue`);
- the `SchemaAdapter` interface and its compilation result types;
- interaction descriptor and contract/Program digest functions;
- `INTERACTION_ID_PATTERN` and `isInteractionId`;
- `createProgram`, `validateProgram`, `composePrograms`, and `diffPrograms`;
- `contractCompatibility` for explicit expected and offered contracts;
- `contractChanges`, `ContractChange`, `ContractDelta`, and `ChangeKind` for
  declaration review;
- `createCatalog` and `validateCatalog`.

### JSON primitives

Hosts use these to keep journals, evidence and caches consistent with the
identities Boundary derives:

| Function | Contract |
| --- | --- |
| `normalizeJson(value)` | Returns a frozen JSON value or throws `JsonError`; rejects non-JSON values, cycles and non-finite numbers. |
| `cloneJson(value)` | `normalizeJson` typed as the input's JSON type. |
| `canonicalJson(value)` | Canonical text: object keys in unsigned UTF-8 order, no insignificant whitespace. |
| `jsonEquals(a, b)` | Equality of canonical text. |
| `hashJson(domain, value)` | `sha256:` digest of the canonical text under a non-empty domain string. |
| `sha256(value)` | `hashJson` with the `canonical-json/v1` domain. |
| `isSha256Digest(value)` | Checks the `sha256:` plus 64 lowercase hex form. |

UTF-8 ordering, exact-object snapshots and schema compilation are internal to
the SDK; their observable results reach hosts only through these functions and
the digests Boundary derives.

`diffPrograms(left, right)` reports interaction IDs as `added`, `removed`,
`changed`, and `unchanged`. A changed entry means its contract digest changed.

The hardened Zod 4 compiler remains available through
`@foxworth/boundary/program/zod`:

```ts
import {
  compileZodSchema,
  zodSchemaAdapter,
} from "@foxworth/boundary/program/zod";

const compiled = compileZodSchema(schema, "input", "todos.create.input");
```

It emits the bounded portable schema plus annotations and rejects Zod behavior
that cannot be represented faithfully.

## Version 1 artifacts

Program owns the portable v1 shapes Host produces and Handoff validates:
`InstallationManifest`, `SurfaceManifest`, `BindingManifest`,
and the identity-bearing `RawInvocationOutcome` envelope. They carry Programs,
Catalogs, and digests only. They do not contain handlers, admission, context,
or revocation.

Handoff imports those types from `@foxworth/boundary/program`. Host still creates the
live Installation, Projection, and Binding values and re-exports the artifact
types that appear on that authoring path.

Continue with [Host](./host.md), [Handoff](./handoff.md), and the
[normative identity laws](../spec/02-contracts-and-identity.md).

## Composition artifacts

`InvocationObservation` and `validateInvocationObservation` define the portable,
payload-free invocation evidence described in the [Host reference](./host.md#empty-surfaces-observations-and-agent-presentation).
Validation checks data and completion consistency; the receiving host separately
authenticates its event channel.

`ExecutionEvidence` and `validateExecutionEvidence` add a separate versioned
envelope with explicit invocation, subject, parent/child, attempt and receipt
references. Completed invocation evidence does not imply completion of its
subject. See [causal execution evidence](./execution-evidence.md) for validation,
host publication, independent Rust support and evidence limits.

`SurfacePresentation`, `PresentedInteraction`, and
`InteractionPresentationOverride` describe handler-free agent presentation data.
The Host derives this artifact with `presentSurface`; its independent digest
records presentation changes without changing Program or Projection identity.
`bindingDescriptions` joins selected declaration pins from a previously checked
Binding manifest without authenticating its source. Native integrations use
`describeBinding` for an authentic capability. `isInvocationFaultLegal` checks
the stable v1 mode/cause/certainty law shared by retained native and Handoff
outcomes; a truthful result still requires evidence supplied by the host.
