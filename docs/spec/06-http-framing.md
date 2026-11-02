---
title: "6. HTTP framing for version 1 Handoff"
description: "Exact HTTP framing for hosts implementing Handoff version 1 interoperability."
---

# 6. HTTP framing for version 1 Handoff

**Status:** Current and normative for hosts that choose HTTP.

Handoff is transport-neutral: it defines envelopes and leaves framing to the
host. This section specifies one HTTP framing so independently authored hosts
and clients interoperate. A host MAY carry Handoff over any transport. A host
that calls its HTTP surface the version 1 Handoff protocol MUST frame it
exactly as specified here.

Reviewed evidence is `tests/conformance/v1/http-framing.json`, consumed
independently by both implementations.

## Two routes under a host-chosen base

A conforming surface MUST expose exactly two routes beneath one absolute base
path. The base MUST NOT be the application root and MUST NOT carry a trailing
slash.

| Route | Method | Path |
| --- | --- | --- |
| Manifest | `GET` | `{base}/manifest` |
| Invoke | `POST` | `{base}/invoke` |

Any other path MUST be rejected. A specified path under a different method is
not that route; it MUST be rejected the same way an unknown path is. Response
bodies MUST use `application/json; charset=utf-8`. Requests carry
`application/json`.

## Manifest and cache validation

The manifest route MUST return the version 1 Surface Binding manifest with
status `200`, `cache-control: no-cache`, and an `etag` of the binding digest in
double quotes.

The validator is exact Binding identity rather than a timestamp. A replaced
Installation produces a different binding digest and therefore a different
entity tag, so a client holding a stale surface revalidates rather than
trusting a cached one.

When `if-none-match` equals the current entity tag, the receiver MUST return
`304` with an empty body and MUST echo the entity tag. A manifest is a
description of what was pinned; it is not live authority and never becomes one
by being cached.

## Invocation and outcome

The invoke request body MUST be the bare version 1 Handoff invocation envelope.
The response body MUST be the bare version 1 Handoff outcome envelope. Neither
is wrapped in an enclosing object.

A fault is still an outcome. It MUST be carried as an outcome envelope on a
non-2xx status, so a client MUST read the envelope rather than infer meaning
from the status alone.

Status is a function of the outcome result:

| Result | Status |
| --- | --- |
| `returned` | 200 |
| `proposed` | 202 |
| `denied` | 403 |
| `declared-error` | 422 |
| `fault` with cause `invalid-input` or `invalid-invocation` | 400 |
| `fault` with cause `revoked` | 409 |
| `fault` with any other cause | 500 |

A declared error is `422` rather than `400`: it is a domain alternative the
contract predicted, not a malformed request. A revoked pin is `409` rather than
`400`: the caller should re-handshake, not repair its request. Collapsing
either distinction would make a moved deployment look like a caller defect.

Neither a `500` nor any other status is permission to retry. Retry safety
follows the outcome's execution certainty, not its HTTP status.

## Rejection before an outcome exists

When the receiver rejects a request before producing an outcome, it MUST return
a diagnostic envelope instead:

```json
{
  "error": {
    "kind": "protocol",
    "code": "ROUTE_NOT_FOUND",
    "path": "request.url",
    "message": "No version 1 protocol route matched."
  }
}
```

`kind` MUST be `protocol` when the receiver recognized the failure and
`internal` otherwise. An `internal` rejection MUST NOT carry a path, because a
path would disclose host structure to an untrusted caller. A rejection MAY
carry `issues`, an array of `{ path, message }` portable validation evidence.
Native exception text, stack traces, and host internals MUST NOT cross.

| Rejection | Status | Kind | Code |
| --- | --- | --- | --- |
| No route matched | 404 | `protocol` | `ROUTE_NOT_FOUND` |
| Empty or unparseable body | 400 | `protocol` | `INVALID_REQUEST` |
| Unrecognized failure | 500 | `internal` | `REMOTE_EXECUTION_FAILED` |

A recognized rejection MUST use `409` when its code begins with `STALE_` or is
`INTERACTION_NOT_EXPOSED` or `MODE_NOT_EXPOSED`, and `400` otherwise.

## What this framing does not establish

Serving these routes does not authenticate a caller, and a valid manifest is
not a grant. The receiver MUST derive invocation context from its own native
request handling; a header, cookie, or transport principal is input to that
resolution and MUST NOT be treated as identity by mere presence. Admission
still evaluates every invocation, and every Handoff validation stated in
[section 4](./04-surfaces-handoffs-and-conformance.md) applies unchanged.
Transports frame bytes; they never reconstruct conservation rules.
