# Boundary

Suppose you're building a document app. Somewhere inside it is a function:

```text
search("spring") → matching documents
```

A search box calls it. Results appear. One piece of your application calls
another.

Your application also knows how to delete a document:

```text
your application

  search(query) → matches
  delete(id)    → deleted
```

Now you want to add an assistant that helps people find documents.

It needs search. Giving it access to deletion would add something its job
doesn't require.

So draw a box around search:

```text
your application
┌───────────────────────────────────┐
│                                   │
│  assistant's interface            │
│  ┌─────────────────────────────┐  │
│  │ search(query) → matches     │  │
│  └─────────────────────────────┘  │
│                                   │
│    delete(id) → deleted           │
│                                   │
└───────────────────────────────────┘
```

**Boundary makes that box an explicit part of your program.**

To build it, describe the actions your application offers. Each description
gives an action a name, says what input it accepts, and says what a caller can
expect back. Boundary calls this an **interaction**.

Your ordinary functions supply the implementations:

```text
declared interaction                application code

search(query) → matches ──────────── searchDocuments(query)

delete(id) → deleted ─────────────── deleteDocument(id)
```

With those descriptions available, you can select search for the assistant's
interface, and search plus delete for the editor's interface:

```text
assistant's interface               your application
┌──────────────┐
│ search       │─────────────────┐
└──────────────┘                 │  ┌─────────────────┐
                                 ├─→│ searchDocuments │
editor's interface               │  └─────────────────┘
┌──────────────┐                 │
│ search       │─────────────────┘
│ delete       │────────────────────→ deleteDocument
└──────────────┘
```

Boundary checks that the selected interface can be fulfilled before
connecting it to the application.

That connection lets a caller request an action. Your application still
decides whether a particular request is allowed. Search might involve private
documents; deletion might require ownership. Your application supplies those
rules and applies them when requests arrive.

So far, we've connected callers to actions. Now watch what happens when an
action changes something.

Someone has these search results open:

```text
search("spring")

  spring-plans.md
  spring-budget.md
  spring-notes.md
```

They delete `spring-budget.md` through the editor.

The deletion succeeds. But the search results still show the document.

To update the screen, we need to connect **what deletion changes** to **what
search depends on**. We can put that information in the interaction
declarations:

```text
search
  takes:    a query
  returns:  matching documents
  reads:    documents

delete
  takes:    a document ID
  returns:  deletion result
  changes:  documents
```

Look at the relationship those last lines reveal:

```text
delete ── changes ──→ documents ←── reads ── search
```

Once the application delivers an observation of the deletion, Boundary's read
machinery can use that relationship to refresh the mounted search:

```text
delete completes
       │
       ▼
application reports the change
       │
       ▼
search depends on documents
       │
       ▼
search runs again
       │
       ▼
the screen shows the current results
```

The deletion could come from the editor or a command-line tool. The
relationship stays the same.

**The interaction declarations are now something other parts of the
application can build on.** Caller interfaces select from them. Connections
check them. Read machinery uses their declared dependencies. Your application
supplies the implementations and delivers the observations.

Now suppose you want the assistant to help clean up old documents. It should
be able to propose a deletion for review.

You expand its interface to include **requesting** deletion. When you wire
deletion through Boundary's optional controlled path, calling and requesting
have distinct meanings:

```text
call delete       → perform the deletion, if admitted

request delete    → prepare a proposal for review
```

The assistant's request produces something the application can retain and
someone can inspect:

```text
assistant                  application

request deletion ────────→ prepare proposal
                                │
                                ▼
                          record approval
                                │
                                ▼
                       grant execution authority
                                │
                                ▼
                          attempt deletion
                                │
                                ▼
                          verify the result
```

The application owns the review rules, storage, and execution. The assistant's
ability to request a deletion gives it a way to participate without giving it
the authority to approve or execute that proposal.

There is another detail hiding at the end of that diagram.

Suppose deletion starts, then the connection disappears. The document might
already be gone. Reporting failure could encourage someone to repeat the
action; reporting success would claim something we haven't established.

Boundary can preserve that outcome as **uncertain**. The application then
checks reality to determine what happened.

We now have a model that reaches from an available action to a particular
request, through the application's decision, and into evidence about its
outcome.

Pull back:

```text
                 declared interactions
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
          caller       reads and    request and
        interfaces      changes     outcome handling
             │            │            │
             ▼            ▼            ▼
          checked      affected      proposals,
        connections      views       review, evidence
             │
             ▼
      application implementations
```

The collection of interaction declarations is what Boundary calls a
**Program**. You can inspect it, combine declarations from different modules,
and select caller interfaces from it before connecting any implementations.

**Boundary is a programming model for describing application interactions and
building around those descriptions.**

You decide what the actions mean and supply the code that performs them.
Boundary gives callers, adapters, and supporting machinery a shared
description to work from.

A new UI, CLI, or assistant can then participate in the application's existing
model of work: requesting its actions, passing through its decisions, and
observing the consequences.

## Try the model in TypeScript

The executable walkthrough below adds document review: read a document,
suggest a change, and accept a suggestion. It uses ordinary application review
rules. For the optional proposal, grant, and recovery lifecycle, see
[controlled effects](./docs/guides/controlled-effects.md); for observation
delivery and read refresh, see [shared updates](./docs/guides/humans-and-agents.md#make-shared-updates-truthful).

The optional [Yjs and Automerge snapshot adapters](./docs/guides/crdt-snapshots.md)
are **experimental**: their APIs may change incompatibly and have no production
support commitment. See [availability and support](./docs/concepts/current-status.md).

### Start with reading

The editor needs to read the document. Start with that one interaction:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#read -->
```ts
import { z } from "zod";
import { defineInteraction } from "@foxworth/boundary";

const Document = z.strictObject({ text: z.string(), revision: z.number().int().nonnegative() });
const readDocument = defineInteraction({
  id: "document.read",
  input: z.strictObject({}),
  output: Document,
  reads: ["document"],
});
```

This says what a caller can expect: the document's text and revision. The
revision identifies which version someone read. The code that fetches it will
come later; this is just the agreement between that code and its callers.

### Now let someone suggest a change

The assistant reads “Launch on Friday.” and suggests “Launch on Tuesday.”
What should the document say now?

```text
before                  after suggest               after accept

Launch on Friday.       Launch on Friday.            Launch on Tuesday.
                        suggestion: Tuesday         suggestion accepted
```

It still says Friday. Suggesting adds a review item; accepting changes the
document. Let's make that distinction explicit, one piece at a time.

A suggestion needs an ID, proposed text, and the document revision it was based
on. A rejection carries the application's reason—for example, that the
reviewed document has since changed:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#review-data -->
```ts
export const Suggestion = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  basedOnRevision: z.number().int().nonnegative(),
});
export const reviewRejected = z.strictObject({ reason: z.string() });
```

Now declare the action. Notice `changes`: it names suggestions, not the
document.

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#suggest -->
```ts
const suggestChange = defineInteraction({
  id: "document.suggest",
  input: Suggestion,
  output: Suggestion,
  errors: { reviewRejected },
  reads: ["document", "suggestions"],
  changes: ["suggestions"],
});
```

Accepting is a separate action. It takes a suggestion ID and returns the
updated document. Its `changes` includes the document:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#accept -->
```ts
const acceptSuggestion = defineInteraction({
  id: "document.accept",
  input: z.strictObject({ suggestionId: z.string() }),
  output: Document,
  errors: { reviewRejected },
  reads: ["document", "suggestions"],
  changes: ["document", "suggestions"],
});
```

The [application's ordinary functions](./examples/snippets/typescript/document-review-store.ts)
store suggestions and enforce revision and review rules. Boundary doesn't invent
those rules or supply the document store.

### Connect the callers

Put the three interactions in a record. They now form the shared vocabulary for
the editor, CLI, and assistant:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#interactions -->
```ts
export const reviewInteractions = {
  read: readDocument,
  suggest: suggestChange,
  accept: acceptSuggestion,
};
```

The following excerpts connect these declarations to the
[application's handlers](./examples/snippets/typescript/document-review-host.ts).
Together they form one executable example.

<!-- snippet:examples/snippets/typescript/document-review.ts#imports -->
```ts
import { createReviewApplication } from "./document-review-host";
import type { ReviewActor } from "./document-review-store";
```

Select the actions each caller needs from the same declarations. A selection
is a **Surface**. The CLI and assistant can share one because both need to
read and suggest; the editor also needs to accept. A Surface exists before any
implementation does.

<!-- snippet:examples/snippets/typescript/document-review.ts#surfaces -->
```ts
const editorSurface = surface(reviewInteractions, { call: ["read", "suggest", "accept"] });
const contributorSurface = surface(reviewInteractions, { call: ["read", "suggest"] });
```

An **Installation** pairs the declarations with this application's live
implementations. The host names the installation and its release `version`;
Boundary never derives either from code. The application below owns one
document and its suggestions:

<!-- snippet:examples/snippets/typescript/document-review.ts#installation -->
```ts
const application = createReviewApplication();
const app = await install(reviewInteractions, {
  id: "review:local:1",
  version: "release-1",
  handlers: application.handlers,
});
```

**Connecting** a Surface checks that the whole selection can be served by that
installation, then returns a caller with one method per selected interaction.
`admit` is required: the host's admission rule runs on every call, and holding
a Surface or a caller is never authority by itself.

<!-- snippet:examples/snippets/typescript/document-review.ts#connections -->
```ts
const editor = await app.connect(editorSurface, {
  admit: admitWhen((actor: ReviewActor) => actor.kind === "editor", "Editor required"),
});
const contributor = await app.connect(contributorSurface, {
  admit: admitWhen(
    (actor: ReviewActor) => actor.kind === "script" || actor.kind === "assistant",
    "Contributor required",
  ),
});
```

These fixture identities stand in for authenticated callers. In a remote app,
the server constructs them from trusted authentication; caller-supplied labels
are not permission.

<!-- snippet:examples/snippets/typescript/document-review.ts#actors -->
```ts
// Local fixture identities. A remote host derives these from authentication.
const editorActor: ReviewActor = { id: "alex", kind: "editor" };
const scriptActor: ReviewActor = { id: "review-cli", kind: "script" };
const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };
```

Now let the CLI and assistant suggest different dates. The editor chooses one:

<!-- snippet:examples/snippets/typescript/document-review.ts#review -->
```ts
const original = await contributor.read({}, scriptActor);
await contributor.suggest({
  id: "cli-1", text: "Launch on Monday.", basedOnRevision: original.revision,
}, scriptActor);
const suggestion = await contributor.suggest({
  id: "assistant-1", text: "Launch on Tuesday.", basedOnRevision: original.revision,
}, assistantActor);
// The document is still "Launch on Friday." Both changes are suggestions.

const accepted = await editor.accept({ suggestionId: suggestion.id }, editorActor);
// accepted: { text: "Launch on Tuesday.", revision: 1 }
```

Can the assistant call `accept`? Its caller has no such method, because its
Surface never selected one. Calling through the editor's caller with an
assistant identity also fails admission.

The application separately checks that an editor cannot accept their own
suggestion, or accept one based on an old document revision. Selection,
admission, and domain rules each do a different job.

### Change one thing. Predict what still works.

Suppose you replace the implementation. The selected interactions still mean
read, suggest, and accept, with the same declared contracts. You connect the
existing Surface to the new installation explicitly. Existing callers remain
attached to the original installation.

<!-- snippet:examples/snippets/typescript/document-review.ts#replacement -->
```ts
// A fresh set of implementation functions shares the application-owned store.
const replacementApplication = createReviewApplication(application.store);
const replacement = await install(reviewInteractions, {
  id: "review:local:2",
  version: "release-2",
  handlers: replacementApplication.handlers,
});
const assistant = await replacement.connect(contributorSurface, {
  admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
});
// The editor and the contributor above stay attached to the first installation.
```

Now suppose a replacement declares that `suggest` also changes the document.
Its name, inputs, and outputs are unchanged. Should the contributor's existing
Surface still connect?

```text
caller expects suggest to change       installation declares it changes

suggestions                     ✓      suggestions
suggestions                     X      suggestions + document
```

<!-- snippet:examples/snippets/typescript/document-review.ts#changed-contract -->
```ts
// It now changes the document too. The old read-and-suggest surface must fail,
// even though the interaction ID, inputs, and outputs have stayed the same.
const changedInteractions = {
  ...reviewInteractions,
  suggest: defineInteraction({
    id: "document.suggest",
    input: Suggestion, output: Suggestion,
    errors: { reviewRejected },
    reads: ["document", "suggestions"],
    changes: ["suggestions", "document"],
  }),
};
const dispatches: string[] = [];
const changed = await install(changedInteractions, {
  id: "review:auto-apply:1",
  version: "release-1",
  handlers: {
    read() { dispatches.push("read"); return application.store.read(); },
    suggest(input) { dispatches.push("suggest"); return input; },
    accept(input, actor: ReviewActor) { dispatches.push("accept"); return application.handlers.accept(input, actor); },
  },
});
const result = await changed.tryConnect(contributorSurface, {
  admit: admitWhen((actor: ReviewActor) => actor.kind === "assistant", "Assistant required"),
});
// result.status === "unrealized": suggest's declared write footprint grew.
```

Boundary refuses the second connection before running any interaction. The expected
write footprint changed. Checking only the function's name and data shapes
would miss that difference.

This checks declared agreement. It cannot prove an implementation obeys its
declared footprint or that a suggestion improves the writing.

The [complete example](./examples/snippets/typescript/document-review.ts) and
[its tests](./tests/typescript/document-review-docs.test.ts) exercise the review,
refusals, and explicit replacement. They use local calls and in-memory state.
The [caller guide](./docs/guides/adding-a-caller.md) explains the additional
transport step for a real CLI, browser, or agent connection, and the
[host reference](./docs/reference/host.md) documents `surface`, `install`,
`connect`, and the explicit pipeline underneath them.

## Where it earns its place

Use Boundary when an application's actions need to survive changes in caller,
implementation, or deployment. An editor, developer tool, framework, or service
can keep its own model while giving each caller a checked interface to it.
A private helper whose callers and implementation always change together can
remain an ordinary function.

Other examples show different reasons to make that agreement explicit:

- [Investigate a support ticket, then review its resolution](./docs/guides/next-domains.md#triage) — callers work through application-owned review and revision rules.
- [Load a plugin implementation](./docs/guides/plugins.md) — keep the interaction declaration with the host while another language supplies the implementation.
- [Publish with evidence of completion](./docs/guides/controlled-effects.md) — add explicit approval, execution, verification, and reconciliation when a returned value isn't enough.

The document review above uses ordinary application rules. Consequential
effects can use Boundary Control; an ambiguous outcome stays uncertain until the
host reconciles it, without permission to repeat the effect.

## Run the example

Packages are currently unpublished; [availability and support](./docs/concepts/current-status.md)
records the release boundary. From this checkout, after installing its pinned
toolchain and dependencies:

```console
pnpm exec vitest run --config config/vitest.config.ts tests/typescript/document-review-docs.test.ts
```

## Use Boundary locally

Until the package is published, a sibling project installs a packed snapshot
from this checkout, not workspace source:

```console
just pack
pnpm add "file:vendor/boundary/<SHA256_HEX>/foxworth-boundary-<VERSION>.tgz" "zod@<ZOD_PEER_RANGE>"
```

[Use Boundary locally](./docs/guides/local-consumers.md) covers vendoring the
snapshot, verifying the installed bytes, peers, and bundling rules for
applications and reusable libraries.

[Continue with the model and guides](./docs/README.md). The map also links to
framework integrations, package references, and the independent native Rust
implementation. Native C and C++ hosts can follow the [embedding guide](./docs/guides/native-embedding.md).

The [WebSocket Todo room](./examples/apps/typescript/websocket-room/README.md)
adds a local streaming AI guide, deferred tool discovery, reconnect replay,
and host-owned completion proposals with explicit screen approval.
