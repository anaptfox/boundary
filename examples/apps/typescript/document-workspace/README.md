# Document workspace

A Next.js document you can save, review, and hand to local agents or MCP
callers. The running app is named **Folio**. The host owns the editor, sessions,
and persistence. Base UI supplies the session menu, interface dialog, and
formatting tooltips; Tiptap supplies the editor. These packages are
dependencies of this example, not of any Boundary library.

The editor supports headings, bold/italic text, lists, quotes, code and undo/redo.
Save explicitly or use Cmd/Ctrl+S while editing. Session changes warn before
discarding a draft; conflicts and uncertain saves keep the draft visible and
block resubmission. Long titles wrap on small screens. Without client JavaScript,
the native form remains a plain-text editor; rich formatting requires JavaScript.

Rich formatting is an optional app-owned `richText` JSON string, validated with
the same ProseMirror schema before effects. The server derives the plain `body`
from that rich content. Plain-text callers can omit `richText`; such saves replace
the rich representation with plain text. Existing saved documents are not reset.
No HTML injection, links, or embeds are part of this editor's schema. The added
field changes this demo's contract identity; it does not change an Boundary wire law.

This runnable example keeps document state in `data/documents.json`, exposes a
single selected protocol route, and has two seeded demo sessions: Alice may save
the document and Bob may read it. The sessions are deliberately cookie fixtures
for a local proof, not production authentication or authorization guidance.

All runtime state under `data/` is ignored by Git. With no document store, the
app shows a built-in launch brief and creates the store on the first save.
Existing documents are never reset or replaced by that seed; malformed stores
remain errors. `BOUNDARY_FOLIO_DATA_DIR` can select a separate data directory.

Run `pnpm --dir examples/apps/typescript/document-workspace dev`, choose a session, and save as Alice.
The page form invokes an app-owned Next Server Action, which derives context,
calls the existing pinned Binding directly, returns a typed conflict/rejection
result, and revalidates the page after a completed save. The separate
`/documents/save` route is an external HTTP interface, while `/api/boundary/manifest`
and `/api/boundary/invoke` are the selected protocol boundary. The app intentionally
transpiles workspace packages through Next; packed-consumer distribution is a
separate acceptance concern.

`just next-native-smoke` builds the public packages and runs an isolated copy
through the default Next production bundler and a localhost server. It checks
the real progressive-enhancement form metadata, saved/conflict/denied states,
persisted revision, and the catch-all protocol route. The fixture preserves
the installed peer-dependency layout instead of copying a second Host or React
under every consumer.

The form starts idle. A possibly-started save failure remains `uncertain` and
does not enable an automatic retry. JSON writes are serialized and atomically
replaced inside one application process; this is not multi-process storage,
durable Control recovery, or the complete MCP/WebMCP showcase.

## Local chat

Folio is one document and one shared chat—no navigation sidebar or history browser.
**Reset chat** clears the conversation for everyone and starts fresh with the
current document unchanged. It does not archive conversations or undo document
edits. Stop active work and let it settle first; an uncertain save outcome must
be reconciled before clearing its evidence. Two named
collaborators use the same local model with different interaction selections:

| Collaborator | Available Boundary interactions | Job |
| --- | --- | --- |
| Scout | `documents.get` | Discuss, clarify, review and suggest. Cannot save. |
| Editor | `documents.get`, `documents.save` | Draft; apply the exact human-approved revision. |

Start your existing Ollama service, then open the demo. No accounts or secrets
are required; no model is downloaded. Chat settings list installed local models.
`OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434` and accepts only a loopback
HTTP origin. `OLLAMA_MODEL` selects an installed default. Otherwise the demo
prefers the verified `qwen3.6:35b-mlx` when installed, then `llama3.2:3b`.
The larger model is slower; the smaller model can be unreliable at editing tools.
The room requires JSON-schema output support from the local backend. It explicitly enables structured output and never treats partial JSON as an action. A malformed response gets at most one inference continuation; unsupported backends fail visibly.
Response-limit and provider-stream failures stop immediately without another
model call, even if the received prefix parses as a valid draft. The next
exchange waits for the current room work to settle; no partial response becomes
a proposal or approval.
Cloud-backed model entries are excluded; there is no cloud fallback. Model quality and speed vary.

1. Write to the room. There is no agent selector. Explicit human addresses go
   straight to the named collaborator; otherwise the local model proposes who
   should contribute. Agent handoffs use the validated `handoff` step,
   recorded as app-owned `room.invite`, not an Boundary interaction or save approval.
   Model prose is no longer interpreted as an executable invitation.
2. Each contribution starts with an actual `documents.get`. Agents must deliver
   a result, ask a question, hand off, or produce an actual draft. They can
   contribute again after a colleague's review. An intention-only reply receives
   one bounded continuation, then fails visibly if it still produces no action.
3. Questions appear inline as choices, Yes/No, or open text. Choices also accept
   an answer in your own words. The requesting human answers the specific
   question to resume the original goal, queued collaborators and draft. Other
   viewers can see the question but cannot answer on that person's behalf.
4. Editor's `draft` step produces a complete, unsaved title and formatted body. Scout
   reviews it and may request revisions or clarification. A completed review
   offers **Apply** or **Keep as draft**. Apply executes exactly the stored
   draft against its original revision, without asking the model to rewrite it.
   Only Alice with current edit access can apply; the UI also blocks Apply over
   an unsaved human draft. An ordinary chat message or clarification answer
   never grants save permission. The old Allow one save checkbox is removed.
5. A confirmed save refreshes Next and shows the actual new revision. Conflicts,
   rejections and uncertain outcomes remain visible and are never retried or
   silently rebased. Keep as draft leaves the document unchanged.

Enter sends; Shift+Enter adds a line. You can interrupt with another message or
stop the exchange. Already-started tool work settles before the next exchange;
stopping cannot undo a save. If several human messages arrive while work stops,
their text remains visible, but only the newest queued message starts an exchange.
A new ordinary message cancels pending questions and starts new work, without inheriting approval. Stop cancels a pending question too.

The app persists the room in ignored `data/room.json`. Tabs and seeded sessions
share its messages through server-sent events. Reloading/reconnecting reads a
snapshot, never replays a message. Accepted message and answer IDs are deduplicated. An idle pending question survives restart and resumes only after its owner answers; interrupted work is never replayed. After
a server restart, unfinished work is marked interrupted and an unconfirmed tool
result is uncertain; nothing resumes automatically. Streaming text is checkpointed
at phase/tool boundaries, not durably written token by token. The local demo stops
accepting messages at 100 human submissions per conversation; use Reset chat to
start another. Reset removes conversation text from the room file. Accepted
request-ID fingerprints remain solely to prevent delayed duplicates executing
again, not as a browsable history. File-system backups are outside this demo.

The work loop permits eight contributions per active burst, 32 across question continuations, and 240 seconds per burst. Repeated empty actions stop after two attempts. These are limits, not a guarantee of model quality or task completion.

Both collaborators receive bounded recent context (up to 24 messages and 22,000
characters). Old chat and model prose are never proof of current state or
permission. Each collaborator reads the saved document, not an unsaved human draft.
The seeded cookie sessions are not secure multi-user authentication.

The demo uses `ai` and
`@ai-sdk/openai-compatible`. The SDK validates JSON-schema work steps (ask, handoff, draft, complete);
Boundary handles selected invocation contracts and outcomes. The app owns agent
identities, tool selection, UI, cookies, policy, storage, conversation context
and Next refresh. The native Next `after()` lifecycle runs accepted work after
the response; a separate event stream lets viewers leave and reconnect. This is
a bounded, single-process room on a persistent Next Node server, not distributed
collaboration, a production durable worker, or an Boundary agent runtime. Hosting
request-lifetime limits still apply. No Boundary library acquires an AI SDK dependency.

### Markdown and editable drafts

Chat uses `react-markdown` and `remark-gfm` for headings, emphasis, lists, code,
tables and read-only checklists. Raw HTML is disabled, unsafe link protocols are
filtered, and images display their labels without fetching remote content.

Editor returns `bodyLines`: one Markdown line per entry, including empty entries
between blocks. The app joins those lines and uses `@tiptap/markdown` to convert
them into the same validated rich-text schema as the document editor **before**
publishing a proposal. The preview renders that exact rich representation, and
Apply saves it without reparsing Markdown or running the model again.

**Read full draft** expands a proposal beyond its compact scrolling preview;
**Compact preview** restores it. React ViewTransition keeps that reading change
local to the draft, respects reduced motion, and falls back to an immediate
update in unsupported browsers. Reviewing does not approve or save a draft.

Editable drafts support all six heading levels, paragraphs, bold/italic/strike,
lists, quotes and code. Links, images, HTML, tables and task-checkbox syntax are
rejected visibly rather than silently losing content; ask for ordinary text or
lists instead (URLs and email addresses can be inline code). Chat's wider Markdown
support does not imply that every format is supported by the document editor.
These three packages are demo-only dependencies, not Boundary capabilities.

Title-only edits retain the existing body and rich formatting exactly. Old plain
documents and old proposals are not silently reinterpreted as Markdown. If a
previous model response lost its line breaks, request a formatting-only draft,
review the repair, then Apply. Reset chat never repairs or overwrites a document.

## Inspect the experience

### Publication and external agents

Use **Review revision** below the document, or ask Editor to request publication
of the saved revision. This creates an exact Boundary Control review, not an effect.
Only Alice can approve it. The result is a local published snapshot—not a
deployed website—and leaves the working draft separate. The ignored
`data/publications.sqlite` journal and proposal-keyed effect ledger support
inspection and reconciliation after a lost reply or process restart, without
retrying publication. Reset chat does not remove publication records.

External MCP connects to `/api/mcp` with `Authorization: Bearer
folio-local-read` or `Authorization: Bearer folio-local-draft`. These public
local fixtures are deliberately not production credentials. Read scope exposes
`getDocument` and `publicationStatus`; draft scope also exposes `saveDraft` and
`requestPublish`. No agent tool can approve, grant or execute publication.
`folio-local-foreign` is an intentional wrong-workspace rejection fixture.
The browser optionally registers WebMCP through `/api/agent-boundary` with the
current demo session; no browser support is required for the human workflow.

The same Next app also has focused `/triage` and `/studio` demonstrations.
Their persisted records and interactions are separate from this document and room.

Tests can select disposable storage through `BOUNDARY_FOLIO_DATA_DIR` and
`BOUNDARY_FOLIO_PUBLICATIONS`; `BOUNDARY_FOLIO_SOURCE_ROOT` points to this example for
hashing the publication realization's source. Ordinary development uses this
directory and its `data` folder. Do not point acceptance tests at live data.

The activity panel combines actual Host invocation observations with app-owned
persistence and Next invalidation events. It records only diagnostic metadata,
not prompts, document bodies or cookies, in ignored `data/activity.jsonl`.
The UI reads a bounded tail every two seconds. This is neither a durable audit
journal nor multi-process collaboration. It intentionally distinguishes the
authenticated demo session from the executing collaborator.

“Try a read-only save” narrows authority before invoking the actual interaction.
“Try a stale revision” uses a strictly older revision, never a future revision
that could become current. Neither probe can persist a change. At seed revision
1, revision 0 is rejected by input validation; save once to demonstrate a typed
domain conflict instead. Bob's stale probe is denied by permission first.

`just next-native-smoke` checks these deterministic paths without Ollama. After
building the packages, `node tests/process/document-workspace.mjs --ollama` adds a real
model participant-selection, two-agent discussion, duplicate-message and
read/edit/persistence proof in disposable data. It fails if the model does not
actually save; prose claiming success cannot satisfy it. `--interactive`
keeps that disposable server available for browser review until Enter is pressed.
These checks never reset or edit the user's live document.

## Runtime notes

The document workspace does not enable Cache Components or partial prefetching.
Session, document, and approval state resolve per request behind Suspense.
Save forms use the `/` permalink so progressive Server Action state survives
streaming component placement. The room still uses SSE.

The model menu uses Base UI 1.9 filtering. WebMCP activity is optional browser
metadata and never evidence that an effect completed.

MCP serves protocol 2026-07-28. Native bearer helpers verify expiration, resource
and scopes once before selecting the read or draft Binding. The local
`localTokenVerifier` is a one-hour introspection fixture, not production identity.
Replace it through `createFolioMcpEntry(verifier, resource)` for a host-owned
verifier. Configure `BOUNDARY_FOLIO_MCP_RESOURCE` for the host's resource ID
(default `http://localhost:3000/api/mcp`). Per-tool draft scope preflight adds
no authority beyond that Binding. Local DPoP qualification lives in
`tests/fixtures/auth/dpop.ts` and `tests/typescript/mcp-auth-refresh.test.ts`.

The standalone build opens this app's configured journal. Use
`just next-native-smoke` for the production-build proof with an isolated
seeded journal; an older local journal must be preserved and reconciled rather
than removed to make a build pass.

Action responses render fresh. The native action proof qualifies saved, stale,
and denied states.
