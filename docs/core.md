---
title: "Boundary in one page"
description: "The model, the three calls, the vocabulary, and the laws, written to be read whole by a person or an agent."
---

# Boundary in one page

Boundary makes the interface between a caller and an application an explicit,
checked part of the program. The application declares its interactions once.
Each caller gets a Surface selected from those declarations, connected to a
live Installation under the host's admission rule. The host keeps every
decision; callers hold no authority.

## The three calls

```ts
import { admitWhen, defineInteraction, install, surface } from "@foxworth/boundary";

const docs = {
  search: defineInteraction({ id: "documents.search", input: Query, output: Matches, reads: ["documents"] }),
  delete: defineInteraction({ id: "documents.delete", input: Id, output: Deleted, changes: ["documents"] }),
} as const;

const app = await install(docs, { version: "documents-1", handlers: { search, delete: del } });

const assistant = await app.connect(surface(docs, { call: ["search"] }), {
  admit: admitWhen((actor: Actor) => actor.kind === "assistant", "Assistant required"),
});
await assistant.search({ query: "spring" }, actor);
```

1. `defineInteraction` declares one interaction: id, input, output, declared
   errors, and the state it `reads` and `changes`. It contains no code.
2. `install(record, { version, handlers | dispatch, id?, requests? })` compiles
   the record and installs the application's functions. `version` is the
   host's release label for executable behaviour; `id` defaults to a visible
   `generated:` token. `requests` adds Control proposals.
3. `surface(record, { call, propose })` selects what one caller may see;
   `surface.all(record)` spells out everything. `app.connect(surface, { admit })`
   binds it and returns a caller: one method per `call` alias,
   `propose.<alias>` per `propose` alias, plus `manifest` and `handoff`.
   `admit` is required. `connect` throws `ConnectError` with `expected`,
   `found`, and `fix`; `tryConnect` returns the report.

Everything that holds authority stays on `app`: `revoke(caller)`, `revoke()`,
`binding(caller)`, `program`, `installation`, `manifest`.

## Serving a caller

Adapters take the caller, never a wider value: `createHttpHandler({ caller, routes })`,
`createMcpHandler({ caller, tools: toolsFor(caller) })`,
`registerWebMcpBinding({ caller, tools })`, `createNextServerCaller({ caller })`,
`createTrpcRouter({ caller, procedures })`. Declarations name an alias the
caller selected: `route(caller, "search", { method: "GET", path: "/search" })`,
`tool(caller, "delete", { mode: "propose" })`. A remote browser pins the
caller's Binding manifest and calls through Handoff.

Tool results tell a model which of six things happened: success, declared
error, denied, invalid, proposed, or uncertain. Proposed means the effect has
not run and awaits review. Uncertain means it may have run: do not repeat it;
check with the installation named in the result.

## Vocabulary

One word per concept. Wire and artifact fields keep their version 1 names.

| Concept | Word | Wire or artifact field |
| --- | --- | --- |
| One declared unit of work | Interaction | `interaction` |
| The declared contract set | Program | `program` |
| What one caller may see | Surface | `projection` |
| Live implementations | Installation | `installation` |
| A Surface connected to an Installation | Binding | `binding` |
| Run it now | `call` | mode `direct` |
| Create a Proposal for review | `propose` | mode `request` |
| Host data passed to every call | Context (the value is an `actor`) | never serialized |
| The host's per-call decision | `admit` | not serialized |
| Per-mode installed identity | `version` option; realization id | `realizationId` |

## Laws that hold on every path

- A Surface exists without an implementation and may never connect.
- Nothing is selected by default; "all" is spelled out.
- `admit` is required; holding a Surface or a caller is never authority.
- The version is host-supplied; Boundary never derives identity from code.
- Connecting checks the whole Surface against the Installation's declared
  contracts first; a changed write footprint is refused before any call.
- A caller carries no controller. Revocation lives on the host-held `app`.
- `uncertain` is its own outcome. It is never a failure, a retry, or an exception.
- The short path returns the real artifacts and adds no behaviour the explicit
  pipeline (`@foxworth/boundary/pipeline`) lacks.

## Where to go next

- [README](../README.md): the document-review walkthrough.
- [Host reference](./reference/host.md): every option of the three calls.
- [The explicit pipeline](./guides/pipeline.md): compile, implement, install,
  project, and bind as separate steps.
- [Adapters](./reference/adapters.md): HTTP, MCP, WebMCP, Next, tRPC, Electron.
- [Controlled effects](./guides/controlled-effects.md): propose, approve, grant,
  execute, reconcile.
- [Glossary](./glossary.md) and the [specification](./spec/README.md).
