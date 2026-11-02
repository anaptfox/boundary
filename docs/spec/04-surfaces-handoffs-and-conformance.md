---
title: "4. Surfaces, Bindings, Handoffs, and conformance"
description: "How surfaces bind to installations and what shared evidence establishes parity."
---

# 4. Surfaces, Bindings, Handoffs, and conformance

**Status:** Current and normative.

## Vocabulary and wire names

The API and this specification use one word per concept. Version 1 artifacts
and the wire keep the field names below; they change only with a deliberate
version 2.

| Concept | Word | Wire and artifact names |
| --- | --- | --- |
| Caller selection | Surface | `projection`, `projectionDigest`, `boundary.projection/v1`, `*.projection.json` |
| Live conjunction | Binding | `binding`, `bindingDigest`, `boundary.projection-binding/v1`, `*.binding.json` |
| Run now | `call` | mode `direct` |
| Create a Proposal | `propose` | mode `request` |
| Live implementations | Installation | `installation`, `installationId`, `installationDigest`, `boundary.installation/v1` |
| Per-mode identity | version, realization | `realizationId` |
| Caller presentation | presentation | `boundary.projection-presentation/v1`, `presentationDigest` |

## Surface is durable desired selection

A Surface MUST be constructed from explicit authentic compiled handles and
non-empty mode sets containing only `"direct"` and `"request"`. It MUST contain
the expected selected-subset Program, exact contract identity, input arity, and
mode selections. Definition-record aliases remain local, but each caller-facing
Surface alias MUST survive serialization and enter Surface identity.

A Surface MUST NOT contain an Installation, Catalog, implementation,
dispatcher, admission function, context, route, or authority. It MAY exist
indefinitely without any realization.

## Binding is total and live

Binding MUST evaluate the whole Surface against one exact Installation. It
MUST return `bound` or an exhaustive `unrealized` report and MUST NOT expose a
partial caller. Expected-to-actual compatibility MUST be checked before any
live capability is returned, and both identities MUST remain pinned.

A Binding MUST pin one Installation ID and digest and one exact Realization ID
per selected mode. It MUST NOT span Installations, mutate, or silently rebind.
Revocation MUST be idempotent and checked before admission and immediately
before dispatch. It cannot cancel work that already started.

A restriction MUST select only parent interaction IDs, exact expected contracts,
arities, and modes, retain exact actual realization pins, and obey inherited
admission and revocation. Private policy and lineage MUST NOT alter Binding
identity. The detailed native restriction law is specified in
[Host authoring](./05-host-authoring-and-artifacts.md#binding-restriction).

## Binding manifest version 1

The wire handshake MUST provide a valid version 1 Binding manifest containing:

- `bindingDigest`, `projectionDigest`, `installationId`, and
  `installationDigest`;
- `expectedProgramDigest`, `actualProgramDigest`, and their validated selected
  Programs;
- the actual selected Catalog; and
- for each `(alias, mode)`, durable caller alias, interaction ID, expected and
  actual contract digests, arity, Realization ID, and request control/preview
  identity where present.

The receiver MUST recompute all content identities and reject duplicate,
missing, unknown, incompatible, or non-canonical entries. A manifest contains
no context, admission, implementation, private target, liveness, or revocation
authority.

## Invocation and context

A version 1 invocation MUST carry `bindingDigest`, `installationId`,
`interactionId`, expected and actual contract digests, mode, `realizationId`, and
portable input. Handoff MUST snapshot the complete invocation and input before
its first asynchronous step and validate every pin against the Binding manifest
before admission or dispatch.

Context MUST be invocation-scoped, remain absent from wire and durable records,
and reach admission and native dispatch by exact reference. A transport-derived
principal is input to the host's context resolver, not authority by itself.

Optional native host coordination MUST follow checked input and inherited
admission, including when disclosing retained outcomes. Its continuation MUST
preserve exact input, context, mode and pins, dispatch at most once, and recheck
revocation after awaited queueing. Restriction MUST retain required coordination.
Retained outcomes MUST match selected identities, schemas and certainty laws;
retention and exact request-to-input association remain host responsibilities.

Handoff MUST perform untrusted manifest, invocation, input, and outcome
validation. A transport MUST only frame and carry bytes and MUST NOT bypass or
duplicate those laws.

## Outcome and certainty

A version 1 outcome MUST echo the invocation identity pins and contain one
tagged result and one certainty: `not-started`, `not-completed`, `completed`, or
`unknown`.

- validated direct return and declared error are completed;
- a request proposal and every rejection before dispatch are not started; and
- a fault is `not-started` only when the dispatcher proves execution did not
  begin;
- a fault is `not-completed` only when execution began and the dispatcher proves
  the interaction did not reach its declared completion; and
- a fault after dispatch is `unknown` when completion cannot be proved either
  way.

An invalid realization return or malformed claimed declared error after
dispatch MUST be `unknown`; it MUST NOT be reported as not started. Invalid
result/certainty combinations MUST be rejected. `not-completed` does not prove
that no partial effect occurred and MUST NOT authorize automatic retry.

An unknown host coordination failure MUST remain `unknown` in either mode.
`realization-failed` with `unknown` is valid for a request invocation; its
`not-started` and `not-completed` variants remain direct-only. A proven ordinary
request-realization failure MAY use `request-failed` with `not-started`.

Declared portable errors MAY cross with validated code and details. The
contract's `errorSchema` describes the complete `{ code, details }` value, and
a receiver MUST validate that whole value, not `details` alone, against both
pinned contracts. Reviewed cases live in
`tests/conformance/v1/declared-errors.json`. Arbitrary
throws and framework failures MUST be sanitized without message, stack, or
private properties.

## Remote pinning

A remote client MUST pin one `bindingDigest`. A changed Surface,
Installation, realization, Binding, or deployment requires an explicit new
handshake. Clients MUST NOT silently follow replacement state.

A remote response MUST echo the sent invocation's identity pins. Reviewed cases
live in `tests/conformance/v1/handoff-response.json`. A mismatch remains unknown
and MUST NOT authorize retry. Echoed pins do not prove that the returned value
was computed from the requested input.

The public protocol MUST accept version 1 only. Every other manifest,
invocation, or outcome version MUST be rejected.

## Adapter law

Descriptive adapters MAY consume an unrealized Surface. Any adapter that can
execute MUST consume a successful Binding or a remote client pinned to its
Binding manifest. Adapters MAY translate routes, tools, procedures, encoding,
or presentation but MUST NOT invent interactions, broaden footprints, change
modes, create context authority, flatten `unknown`, or acquire Control Admin.

There is no adapter-level subset of a Binding. A tool list, route table, or
procedure set MUST present the whole Binding. A caller that must see less is
bound to a narrower Surface, which also keeps unselected interactions out of
the Binding. Presentation (title, description, and documentation) stays outside
identity. Admission remains the execution gate.

## Conformance tests

A conforming implementation SHOULD test at least:

- identity stability under implementation and interface changes;
- identity changes under interaction ID, schema, `reads`, and `changes` changes;
- handler-free Program and indefinitely unrealized Surface serialization;
- authentic handle provenance and duplicate/collision rejection;
- total Bound/Unrealized Binding outcomes and no partial caller;
- restriction subset refusal, inherited admission order, and parent/child
  revocation during awaited admission;
- expected-to-actual compatibility with both identities retained;
- caller-facing alias changes altering Surface identity;
- Installation and Realization ID drift, replacement, and revocation;
- direct and request conservation for one interaction identity;
- stateless exact-reference context through admission and dispatch;
- version 1 manifest, invocation, outcome, arity, and all four certainty
  categories;
- rejection of every non-version-1 wire envelope;
- explicit remote rehandshake after redeployment;
- declared-error identity and arbitrary-error sanitization;
- every Control crash boundary, completed replay, and expired-lease
  reconciliation without reapplication;
- explicit interaction-module loading and deterministic artifact rendering;
- validated read reuse compared with fresh evaluation across point absence,
  query membership, ordering, and pagination changes;
- packed-package subpaths, Control-free Host root, artifact integrity, and fault
  injection.

A packed artifact integrity check MUST bind sorted package-relative paths, byte
sizes, and SHA-256 digests to a versioned `boundary-artifact.json`. An adjacent
trusted receipt MUST bind produced tarball name, version, bytes, and digest
before installation. This establishes integrity relative to that receipt, not
publisher authenticity.

Conformance evidence MUST name implementation, version, vectors, and gates and
distinguish focused evidence from integrated or production proof.

## Composition evidence

A Surface MAY select zero interactions. Its closed Program and selection list
MUST both be empty; binding and handshake MUST preserve its authenticated empty
surface. An empty surface MUST NOT make an unselected invocation executable.

An invocation observation MUST include version 1, binding/surface/installation
identities, expected/actual contract digests, interaction ID, realization ID, mode,
certainty, result kind, and actual read/change footprints. Only an optional
portable JSON `correlation` field is allowed beyond those fields. Inputs, outputs,
and implicit context MUST NOT enter this envelope. Observations MUST validate
identity syntax and certainty/result consistency. They do not authenticate their
publisher, grant authority, or justify retrying an unknown effect. Observation
publication failure MUST NOT change an already obtained invocation outcome.

`ExecutionEvidence` version 1 MUST be a separate envelope; invocation observation
v1 remains unchanged. Its required fields are `version`, `reference` and
`invocation`; optional fields are `subject`, `parents`, `children`, `attempt`
and `receipt`. Every object MUST reject unknown fields. `reference` MUST have
kind `evidence`; `invocation` MUST contain a reference of kind `invocation` and
a validated unchanged `InvocationObservation`. `subject`, when present, MUST
contain a reference of kind `subject` and an explicit state from `pending`,
`completed`, `not-started`, `not-completed`, or `uncertain`. `attempt` and
`receipt`, when present, MUST have their corresponding reference kind.

References MUST contain exactly `kind`, `namespace` and `id`. The allowed kinds
are `evidence`, `invocation`, `subject`, `attempt` and `receipt`. Namespace and ID
MUST contain 1-256 ASCII characters, start with a letter or digit, and thereafter
use letters, digits, `.`, `_`, `~`, `:`, `/` or `-`. Namespace and ID identify one
entity and MUST NOT have different kinds inside an envelope. Parent and child
collections MUST each contain at most 128 unique references. A reference MUST
NOT occur as both parent and child, or name the envelope or its invocation as a
self-link. These checks establish local consistency, not a complete causal graph.

The host MUST choose trusted domain mappings and public redaction explicitly.
Completed invocation or parent evidence MUST NOT promote uncertain subject work
to completion. A missing observation or subject MUST remain absent evidence;
receipt presence MUST NOT infer success. Envelope validation and publication
MUST NOT grant authority, trigger retry, impose global event ordering, or export
private observed-read tokens/scopes automatically. Publication failure MUST
retain invocation and subject truth. Successful publisher return establishes
only that local publication completed, not delivery to every consumer.

A Surface presentation MUST derive schemas, modes, arity, footprints, and
interaction identity from its selected declarations. Overrides MAY supply only
`title` and `description` for selected aliases. Request-only selections MUST omit
direct output/error schemas. The presentation identity is version 1,
`projectionDigest`, and alias-sorted `interactions`; `presentationDigest` hashes this
identity with domain `boundary.projection-presentation/v1` and the existing canonical
JSON/domain separator law. Presentation prose MUST NOT enter callable identity.

`tests/conformance/v1/composition.json` supplies independently reviewed evidence
for empty surfaces, invocation observation validation, and presentation identity.

`tests/conformance/v1/binding-restriction.json` supplies reviewed subset and
admission cases and lifecycle/identity obligations. Both native suites consume
the shared admission and subset cases independently. Their runtime regressions
exercise revocation while admission is suspended.

`tests/conformance/v1/observed-reads.json` supplies point and query evidence cases.
The implementation suites also compare intentionally incomplete evidence against
fresh evaluation to detect unsound reuse. These vectors do not prove the completeness of
arbitrary host snapshots, evaluator purity, runtime performance, or a portable
evidence interchange format.
