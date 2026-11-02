---
title: "ADR 0007 draft: one short path for hosts"
description: "Vocabulary and target API for surface, install, and connect; the decisions D1 to D4; what this supersedes in ADR 0005."
---

# ADR 0007 draft: one short path for hosts

Status: draft, written on the `ergonomic-redesign` branch for the owner to file
under `docs-internal/adr/0007-*.md`. This page is a staging copy; it is not
part of the public documentation set once the ADR is filed. Date: 2026-11-02.

## Context

ADR 0005 made the first clean break toward an ergonomic host entry and produced
`bindInteractions`. It was not adopted: the README kept teaching the explicit
eight-import pipeline, the facade covered direct mode only, and it bound every
caller in one call, so anything touching Control or adding a caller later fell
back to the pipeline. Two paths coexisted and the shorter one lost.

This ADR replaces that facade rather than adding a third surface. The
constraint is value 8: one owner per capability, so there is never more than
one short path in the root export.

## Decision

The TypeScript root exports one short path:

```ts
const docs = { search: defineInteraction({...}), delete: defineInteraction({...}) } as const;

const assistantSurface = surface(docs, { call: ["search"], propose: ["delete"] });
const editorSurface    = surface(docs, { call: ["search", "delete"] });
// surface.all(docs) spells out the everything case; nothing is selected by default

const app = await install(docs, {
  version: "docs-handlers@3",          // required, host-owned
  handlers: { search, delete: del },   // or dispatch: { targets, dispatchers }
  id: "docs:local",                    // optional; visibly generated default (D2)
  requests: (compiled) => contributeControlRequests(compiled, ...), // optional Control bridge
});

// admit is required by the type; there is no admit-all default
const assistant = await app.connect(assistantSurface, { admit: admitWhen((a) => a.kind === "assistant") });
await assistant.search({ query }, actor);       // method per call alias
await assistant.propose.delete({ id }, actor);  // returns a Proposal record, visibly different
// connect throws ConnectError (report, expected, found, fix); app.tryConnect returns { status }

app.revoke(assistant); app.revoke();            // controllers stay on the host-held app
app.program; app.installation; app.manifest; app.binding(assistant).manifest; // real artifacts
```

The facade has no logic beyond composing `compileInteractions`,
`implementInteractions` (or native bindings), `installInteractions`,
`projectInteractions`, `bindSurface`, and `createCaller`. Its tests assert
that the artifacts it returns equal the explicit pipeline's artifacts for the
same inputs, and that contract and Program digests of the reviewed lifecycle
vector are unchanged.

### What a caller holds

A caller carries one method per `call` alias, `propose.<alias>` per `propose`
alias, the read-only Binding `manifest`, and a `handoff` seam
(`manifest`, `resolve`, `invoke`) that adapters use to validate serialized
invocations into this exact Binding. It carries no controller and no broader
selection, so handing it to an adapter cannot widen or revoke anything.
Everything that holds authority stays on `app`, which only the host has.

### Vocabulary (one word per concept)

| Concept | TypeScript API and prose | Wire and artifact (v1) |
| --- | --- | --- |
| Interaction | Interaction | unchanged |
| Contract set | Program (inspection only) | unchanged |
| Caller selection | **Surface** | `projection` (kept) |
| Live implementations | Installation, created by `install()` | unchanged |
| Live conjunction | **Binding**, created by `connect()` | `binding` (kept) |
| Per-mode identity | `version` option; realization ids derived as `<interactionId>:<mode>:<version>` | unchanged |
| Request mode | `propose` (method and surface key) | `request` (kept) |
| Direct mode | `call` (method and surface key) | `direct` (kept) |
| Context | Context (type); examples name the value `actor` | never serialized |
| Admission | `admit` | n/a |

The spec carries this mapping table once. Guides and the glossary use the
API words only; no "aka" tier.

### D1: Projection becomes Surface in the API and prose

`CONTEXT.md` recorded "surface" as an avoided word for Projection, because a
surface sounds like something that exists while a Projection may stay
unrealized. That reason still holds and is answered in the docs: a Surface is
inert data over a declaration record and may stay unconnected forever. In
favour: the README already named its variables `editorSurface`, and newcomers
and agents reach for the word unprompted. The wire and artifact field name
`projection` is kept until a deliberate v2; the pipeline subpath keeps the
`Projection*` type names only where the artifact is literally a projection
manifest, and renames the selection-level types.

Binding keeps its name. The verb `connect()` needs no noun called Connection;
"connection" stays an avoided word because it sounds like a session or a
transport, and a Binding is an all-or-nothing conjunction with admission.

Context keeps its name as the type and parameter name; examples name the value
`actor`. Naming the parameter `actor` would steer authors toward identity,
which Boundary never interprets.

### D2: installation id is optional with a visible default

`install` accepts `id`. When omitted, the id is `generated:<program digest
prefix>:<random>`. The prefix makes the default visible in every manifest and
log line. Hosts that publish Reach records, persist Control state, or replace
an installation deliberately pass an explicit id, because a generated id is
never stable across processes.

### D3: the explicit pipeline lives at `./pipeline`

`@foxworth/boundary/pipeline` carries `compileInteractions`,
`implementInteractions`, `bindNativeInteractions`, `installInteractions`,
`projectInteractions`, `bindSurface`, `restrictBinding`, `createCaller`,
the inspection helpers, and their types. Tests that exercise the pipeline on
purpose (unrealized reports, restriction, admission ordering, native dispatch)
import from it. Nothing in it is a second model: the short path composes it.

### D4: subpath list

Phase 6 records the final subpath list in the pull request description after
auditing which subpaths only re-export another.

## Invariants kept

- Contract and Program digests for existing fixtures do not change.
- `tests/conformance/v1` stays byte-stable unless both implementations and the
  conformance evidence change together.
- A Surface exists without an implementation.
- No default exposes every interaction; `surface.all` is spelled out.
- `admit` is required by the type on every connect.
- `version` is host-supplied, never derived from code.
- `uncertain` stays its own result variant.
- Exactly one short path exists in the root export; `bindInteractions`,
  `BindInteractionsError`, `namedCallers`, and `bindNativeInteractions` as a
  root export are deleted in the same change that lands this one.
- Production Rust never loads TypeScript and production TypeScript never loads
  Rust.

## Supersedes

ADR 0005's `bindInteractions` facade and the "concise authoring" guide. The
clean-break policy of ADR 0005 (packages are unpublished, breaking changes are
allowed, ideas survive, shapes do not) continues to apply.

## Consequences

- Phase 2 migrates adapters to take a caller or a Surface instead of a
  Binding plus handles; each adapter deletes its old entry in the same change.
- Phase 3 removes the explicit exports from the root and renames per D1 in the
  pipeline subpath.
- Phase 4 makes the MCP, WebMCP, and HTTP result envelopes name `proposed` and
  `uncertain` explicitly, with model-readable text.
- Phase 5 rewrites the guides and glossary around the short path.
- Phase 7 (out of scope here) brings the Rust host entry to the same vocabulary.
