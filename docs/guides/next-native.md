---
title: "Next-native server calls"
description: "Call a pinned Binding from a Next Server Action without turning a route into the page API."
---

# Next-native server calls

`@foxworth/boundary/frameworks/next` has two separate jobs.

`createProjectionHandlers(handler)` remains the App Router route-export helper
for an explicit HTTP boundary. It is suitable for browser, MCP, and other
network callers. It does not turn an HTTP route into the server-side API for
your own page or form.

`createNextServerCaller` is the server-side alternative. It calls one existing,
pinned `ProjectionBinding` directly, with host-authenticated context created for
each invocation. It neither installs a host nor makes a loopback HTTP request.

The runnable [document workspace](../../examples/apps/typescript/document-workspace/README.md)
shows the complete application-owned wiring: persisted document state, two
seeded demo sessions, a normal server form, an explicit protocol route, and a
native revalidation after a completed save. Its seeded cookies are local test
fixtures, not a production authentication pattern.

Its `data/` directory is local runtime state, not checked-in conversation or
document history. A missing document store starts with an app-owned launch brief
and persists on the first save. Existing state is preserved; invalid stored data
is not silently reset. Tests use a separate `BOUNDARY_FOLIO_DATA_DIR`.

The host creates and retains the Binding during its own process/deployment
lifecycle. Do not install interactions in a page, action, request handler, or a
module-level “current user” singleton. A selected projected handle is not
permission: every call reaches the Binding's host admission policy with the
fresh context returned by `context()`.

## Reads, actions, and proposals

Use `boundary.read.call` for a direct server read and `boundary.action.call` for a direct
action. Both preserve the interaction’s zero-or-one-input and result types.
`read.call` rejects any interaction that declares changes before context creation
or dispatch, even if its handle is selected for direct invocation.
`boundary.action.request` creates a selected request/proposal; it does not perform a
controlled effect and does not refresh a cache.

`afterAction` runs only after a direct call has returned successfully. It is the
place for host-owned Next cache work such as `updateTag` inside a Server Action,
or a host-chosen revalidation mechanism in another server context. It receives
the authenticated context plus exact Binding and Installation identities so the
host can scope tags correctly. Boundary does not derive cache tags from a portable
footprint: a footprint says what may be affected, not which tenant, object, or
viewer may share cached data.

If cache refresh fails, the action is already completed. `onCacheError` receives
the failure for host logging or recovery; the helper does not retry the action.
Likewise, declared domain errors, denial, revoked/stale Binding failures, and
unknown outcomes are passed through from the pinned Caller. In particular, an
unknown or lost response must be reconciled by the host rather than retried.

## Boundary

The document example's Folio interface uses application-owned Base UI components
and a Tiptap editor. Its formatting is persisted as validated rich-text JSON
alongside a derived plain-text body. These are example dependencies, not Boundary
UI requirements. The plain native form remains available without JavaScript;
the rich editor needs JavaScript, not WebMCP or a model provider.

Session switching, unsaved-draft warnings, save status, and revision conflicts
are shown in the example. It includes the local collaborators described below,
external MCP and optional WebMCP, plus a separate durable publication review.

## A document and two local collaborators

Folio pairs one document with a shared, streaming Ollama chat. Scout can use
`documents.get`; Editor can read, draft, and request publication review. The AI SDK
owns model streaming and structured work-step validation. These are application-owned collaborator roles and
tool selections, not an Boundary agent runtime or a required UI kit.

There is one composer, not an agent selector. Explicit human addresses route
directly; otherwise the local model selects a contributor. Agent handoffs are
validated JSON-schema work steps, never executable prose. The local backend must
support structured output; model tool-choice enforcement alone is not relied on. Each contribution begins
with an actual Boundary read. Neither model receives publication administration;
Editor drafts through an app-owned action and its separate approved execution
path can invoke `documents.save`. Host admission independently rejects Scout
saves. Conversation content cannot replace current state or grant authority.

The app owns a bounded work loop, rather than treating a finished reply as a
finished job. Agents can draft, review, hand back for revisions, or ask a typed
question. Inline questions support choices, boolean decisions, and open text;
choices also accept free direction. The requesting human's answer is bound to
one pending question and resumes the same goal. Another participant cannot
answer on their behalf. Answering a clarification does not authorize a save.

Editor publishes a concrete draft with a pinned base revision. Scout reviews it;
once the review completes the human can Apply or Keep as draft. Apply consumes
that exact stored draft, rechecks current session edit access, and invokes Boundary
without further model inference. No client-authored draft is accepted on the
answer route. Duplicate answers cannot replay an effect. A stale revision
conflicts rather than rebasing; an uncertain save blocks another approval until
reconciliation. This local, app-owned approval is not durable Boundary Control.

Chat renders safe Markdown with `react-markdown` and `remark-gfm`; it never
executes raw HTML or loads model-supplied images. Draft generation preserves
block boundaries as an array of Markdown lines. Before offering approval,
`@tiptap/markdown` converts supported formatting into the editor's validated
rich-text JSON. The preview and the saved document use that same representation;
Apply does not reinterpret the approved content. Chat supports tables and
checklists, while editable drafts deliberately support the narrower editor
schema. Unsupported draft formats fail visibly instead of dropping content.
Existing plain documents are not automatically converted or repaired. These
format and presentation decisions belong to the application, not an Boundary library.

A new ordinary message cancels pending questions and starts new work. Stop also
cancels questions. An idle pending question survives restart but does not resume
until its owner answers. Limits are eight contributions per active burst, 32
across question continuations, 240 seconds per burst, and one additional
inference continuation for an intention-only response. Limit exhaustion is
visible, not reported as successful work. Model task quality remains variable.

Successful saves run `revalidatePath('/')`. The browser refreshes the Next
Server Component payload and updates a clean editor. A dirty editor keeps its
draft and original revision, so another caller cannot silently replace it.
Actual tool-result cards are separate from model prose. The activity panel
shows host observations, app persistence and completed Next invalidation;
safe read-only and stale-revision probes work without a model.

**Reset chat** clears the conversation for every viewer and keeps the document;
there is no history browser. Accepted request fingerprints survive reset to
prevent duplicate execution. Active work or an uncertain save prevents resetting.
The application persists one shared room on the server. Next `after()` runs
accepted work independently of the viewing event stream; tabs receive live
deltas and reconnect to a snapshot without replaying work. Humans can interrupt
or stop. Already-started tool work settles before another exchange starts;
stopping does not undo it. Restarts mark unfinished work interrupted or uncertain,
never automatically resume an effect. This is a bounded, single-process demo,
not a distributed chat service or durable agent scheduler. The cookie sessions
remain local fixtures, not production authentication. Local diagnostics are
best-effort, not an audit journal. Ollama must already be running
with an installed local model; the demo neither downloads models nor falls back
to the cloud. See the [example setup](../../examples/apps/typescript/document-workspace/README.md#local-chat)
for configuration, tests and persistence limits. Room participation, conversation
history, interruption and scheduling belong to the app, not Boundary core.

## Publication and agent entry points

Draft saves and publication are different jobs. `documents.save` changes the
working document. `documents.publish` is selected **only in request mode**:
the human, Editor, MCP and WebMCP can request review of a saved revision, but
requesting does not publish. The application retains Control administration
on the server; Alice's Server Action checks the exact proposal ID and digest,
records her approval, grants and executes. Bob and delegated agents cannot
approve. Server-side preflight rejects a review when it observes a different
saved revision or snapshot; disabling the browser button is not the authority
check. The published record is the exact approved snapshot, not a promise that
the independently editable working document will remain unchanged.

Publication means updating this demo's **local publication record**, not
deploying a website. The preview includes the exact saved title, body and rich
text. The app-owned SQLite journal persists Control records, and a transaction
checks the executor fence and writes the publication plus its proposal-keyed
effect evidence atomically. After a lost reply or restart, inspection shows
uncertainty and reconciliation reads that ledger; it does not run the effect
again. Working-document JSON storage still has only single-process write
serialization. Publication durability does not upgrade chat or draft storage
into a distributed system.

`/api/mcp` selects tools from a server-mapped local bearer fixture. Executor,
delegator and workspace are derived there, never from tool input. The
`folio-local-read` fixture exposes reading and public publication status;
`folio-local-draft` also exposes draft saving and publication requests. These
documented development credentials are not production authentication. Replace
them and seeded cookies with verified app identity before exposing the demo.

WebMCP registers selected browser handles through `/api/agent-boundary`, hydrates
them from the Binding manifest, and derives the current session on every call.
Unmount/session changes dispose registrations. If the browser lacks WebMCP,
the document, chat and review forms still work. Tool visibility does not grant
permission: Host admission independently checks scope and allowed interactions.
Neither entry point exposes approve, grant, execute or a journal object.

Here, public status means safe for authorized workspace callers, not anonymous
internet access: Alice, Bob and the read delegation can see the shared document
and its review previews. Foreign workspace and missing-session calls are denied.
The local seeded identity is an explicit fixture, not a production security proof.

The publication panel polls a narrow status interaction. A failed refresh labels
the last observed state as disconnected; reconnecting reads status and never
replays a mutation. It shows the published snapshot and bounded review summaries,
not private Control state, leases or
administrative objects. Production review identity also pins the Next build ID
and explicit application execution-source set; a new build needs fresh review,
whereas a restart of the same build can reconcile the existing attempt.
These are application-owned projections and UI, not
injected components from Boundary. The SaaS and creative examples have their own
[domain guide](./next-domains.md).

This is a headless server helper, not a Next UI renderer, data store, interaction
registry, or task runtime. Forms, pending UI, error boundaries, cache policy,
and authorization remain application concerns. Current support status and the
remaining framework acceptance work live on the central
[availability page](../concepts/current-status.md).
