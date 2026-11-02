---
title: "Causal execution evidence"
description: "Publish explicit public links while keeping invocation and subject outcomes distinct."
---

# Causal execution evidence

An invocation can complete while the subject it inspects remains uncertain. A
status read of an ACP turn, publication attempt or background job is a common
example. `ExecutionEvidence` v1 carries both facts and explicit host-selected
links. It is separate from `InvocationObservation` v1, whose format is unchanged.

```ts
import { publishExecutionEvidence } from "@foxworth/boundary";
import { validateExecutionEvidence } from "@foxworth/boundary/program";

const evidence = validateExecutionEvidence({
  version: 1,
  reference: { kind: "evidence", namespace: "owner-1", id: "event-1" },
  invocation: {
    reference: { kind: "invocation", namespace: "owner-1", id: "status-read-1" },
    observation: completedStatusObservation,
  },
  subject: {
    reference: { kind: "subject", namespace: "owner-1", id: "run-1" },
    state: "uncertain",
  },
  parents: [{ kind: "invocation", namespace: "owner-1", id: "submit-1" }],
  attempt: { kind: "attempt", namespace: "owner-1", id: "attempt-1" },
  receipt: { kind: "receipt", namespace: "owner-1", id: "receipt-1" },
});
const publication = await publishExecutionEvidence(hostPublisher, evidence);
// publication.evidence retains completedStatusObservation and uncertain run-1,
// including when publication.status is "delivery-failed".
```

`completedStatusObservation` is an existing validated invocation observation;
`hostPublisher` is a host-owned object with `publish(evidence)`. Publication is
explicit. Boundary does not discover links from arbitrary result values, insert
an observer into a Binding, or export private observed-read tokens or scopes.

Every reference has an entity kind, namespace and ID. Namespaces and IDs contain
1-256 ASCII identifier characters: the first is a letter or digit, followed by
letters, digits, `.`, `_`, `~`, `:`, `/` or `-`. Namespace and ID together identify
one entity and cannot denote different kinds inside the envelope. A host chooses
the namespace, identity, redaction and trusted domain mapping. Validation does
not authenticate a publisher or prove the truth of that mapping.

The required fields are `version`, `reference` and `invocation`. `subject`,
`parents`, `children`, `attempt` and `receipt` are optional. Subject state is one
of `pending`, `completed`, `not-started`, `not-completed` or `uncertain`. A missing
subject is absent evidence; it is never inferred from invocation certainty.
Parent or child completion never promotes uncertain subject work to completion.
Receipt presence also says nothing about receipt success.

Parents and children each contain at most 128 references. Duplicate links,
self-links to the envelope or its invocation, and a reference occurring as both
parent and child are rejected. Only local consistency is checked: missing
events, dangling links, remote cycles and global causality are not proved. Array
position, event IDs and delivery order establish no scheduling or global order.

The TypeScript validator clones and deeply freezes data, rejects accessors and
non-JSON values, and closes every object against unknown fields. Validation must
succeed before publication. The publisher returning successfully yields
`published`; it does not prove delivery to or observation by every consumer.
Publisher failure yields `delivery-failed` with unchanged evidence and a private
cause for the host. Neither outcome invokes work or triggers a retry.

Native Rust provides `boundary_core::evidence::ExecutionEvidence::from_value`,
validated deserialization, and `publish_execution_evidence` with a host callback.
The two native implementations consume the reviewed
[`execution-evidence.json`](../../tests/conformance/v1/execution-evidence.json)
independently. These vectors establish local envelope laws, not authenticity,
complete observation delivery, process recovery or authority.
