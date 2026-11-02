---
title: "Domains in a Next app"
description: "Add separate triage and studio domains beside the document workspace."
---

# Domains in a Next app

The runnable Next example adds `/triage` and `/studio` without changing Folio,
its document/room state, root page, or navigation.

## Triage

Acme and Harbor are separate files under `data/triage/`, not rows selected by a
claimed tenant field. An httpOnly local-fixture cookie selects the tenant store;
each Server Action derives that context again. The binding admits only the
human, delegator, or reviewer interaction for its exact host-derived role. Set
`BOUNDARY_FOLIO_DATA_DIR` for an isolated data root; otherwise both examples use
`cwd/data`.

The workflow is create, choose a local deterministic investigator for a bounded
stored-ticket read, inspect the saved delegator/investigator finding and
references, record an app-owned CAS review, then resolve by consuming that
stored review ID. Resolve never accepts free-form resolution text. Ticket
revision checks reject stale review or resolution.

Writes serialize in-process and take a bounded exclusive lock across processes
before reload, compare-and-swap, and atomic replace. A busy or unknown outcome
stays visible as uncertain and is never automatically retried.

## Studio

Studio keeps separate candidate state in `data/studio.json`. It supports stored
candidate create, draft edit, compare, and reviewer-only choose. Candidates are
ordinary app records. Choosing consumes the exact project revision. Its JSON writer serializes only
within one Node process; unlike triage, it does not implement a cross-process
lock.

## Review boundary

The triage review and studio choice are app-owned CAS reviews, not Boundary Control.
This bounded proof has no Control journal, proposal/grant vocabulary, leased
executor, verification, or reconciliation proof.

`tests/process/document-workspace-domains.mjs --base URL` exercises rendered production HTTP
forms and Server Actions after the coordinator has built and started an isolated
Next app. Focused tests do not replace that acceptance run.
