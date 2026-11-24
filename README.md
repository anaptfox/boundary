# Boundary

Boundary is a programming model for describing application interactions. An
interaction is a declaration: a name, the input it takes, the output it
returns, its errors, what it reads, and what it changes. Your own functions do
the work. Boundary builds a checked interface from those declarations for each
caller: a UI, a CLI, or an assistant.

Two interactions from a document app, in plain text:

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

Their last lines connect them:

```text
delete ── changes ──→ documents ←── reads ── search
```

Because that relationship is declared, Boundary can refresh a search on
screen when your application reports a deletion. The same declarations decide
which actions each caller gets.

Boundary has a TypeScript SDK and an independent native Rust implementation.
Neither is published yet; see [Install](#install-not-yet-published).

## Why You'd Want It

Suppose you're building a document app. Somewhere inside it is a function:

```text
search("spring") → matching documents
```

Your app can also delete a document:

```text
your application

  search(query) → matches
  delete(id)    → deleted
```

Now you add an assistant that helps people find documents. It needs search.
Its job doesn't need delete, so don't give it delete. Draw a box around search:

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

You describe each action your application offers: its name, the input it
accepts, and what a caller gets back. Boundary calls this an **interaction**.
Your ordinary functions supply the implementations:

```text
declared interaction                application code

search(query) → matches ──────────── searchDocuments(query)

delete(id) → deleted ─────────────── deleteDocument(id)
```

From those declarations, you select search for the assistant's interface, and
search plus delete for the editor's:

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

Boundary checks that a selected interface can be fulfilled before connecting
it. The connection lets a caller request an action. Your application still
decides whether each request is allowed: search might touch private documents,
and deletion might require ownership. Those rules stay yours.

### Keep Views Current

Someone has these search results open:

```text
search("spring")

  spring-plans.md
  spring-budget.md
  spring-notes.md
```

They delete `spring-budget.md` in the editor. The deletion succeeds, but the
results still show the document.

The `reads` and `changes` lines at the top of this page connect the two. Once
the application delivers an observation of the deletion, Boundary's read
machinery uses that relationship to refresh the mounted search:

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

### Propose Instead of Act

Now you want the assistant to help clean up old documents by proposing
deletions for review. You add **requesting** deletion to its interface. When
you wire deletion through Boundary's optional controlled path, calling and
requesting mean different things:

```text
call delete       → perform the deletion, if admitted

request delete    → prepare a proposal for review
```

The assistant's request produces something the application can keep and
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

The application owns the review rules, storage, and execution. The assistant
can take part without the authority to approve or carry out the deletion.

### Say Uncertain When You Don't Know

Suppose a deletion starts, then the connection drops. The document might
already be gone. Reporting failure could invite someone to repeat the action.
Reporting success would claim something nobody has established.

Boundary can keep that outcome as **uncertain**. The application then checks
reality to find out what happened.

### The Whole Model

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

The collection of interaction declarations is a **Program**. You can inspect
it, combine declarations from different modules, and select caller interfaces
from it before connecting any implementations.

You decide what the actions mean and write the code that performs them.
Boundary gives callers, adapters, and supporting machinery a shared
description to work from. A new UI, CLI, or assistant can then join the
application's existing model of work: request its actions, pass through its
decisions, and observe the consequences.

## Try the Model in TypeScript

This walkthrough adds document review: read a document, suggest a change, and
accept a suggestion. The excerpts form one executable
example; see [Run the Example](#run-the-example).

Other starting points:

- For a shorter native TypeScript setup with named callers, see the
  [concise authoring guide](./docs/guides/concise-authoring.md).
- For the optional proposal, grant, and recovery lifecycle, see
  [controlled effects](./docs/guides/controlled-effects.md).
- For observation delivery and read refresh, see
  [shared updates](./docs/guides/humans-and-agents.md#make-shared-updates-truthful).
- The optional [Yjs and Automerge snapshot adapters](./docs/guides/crdt-snapshots.md)
  are **experimental**. Their APIs may change incompatibly, and they have no
  production support commitment. See
  [availability and support](./docs/concepts/current-status.md).

### Start With Reading

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

A caller gets the document's text and its revision, which identifies the
version they read. The code that fetches it comes later. This is only the
agreement between that code and its callers.

### Let Someone Suggest a Change

The assistant reads “Launch on Friday.” and suggests “Launch on Tuesday.”
What should the document say now?

```text
before                  after suggest               after accept

Launch on Friday.       Launch on Friday.            Launch on Tuesday.
                        suggestion: Tuesday         suggestion accepted
```

It still says Friday. Suggesting adds a review item. Accepting changes the
document. Make that explicit, one piece at a time.

A suggestion needs an ID, proposed text, and the document revision it was
based on. A rejection carries the application's reason, for example that the
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

Now declare the action. Note that `changes` names suggestions, not the
document:

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
store suggestions and enforce revision and review rules. Boundary doesn't
invent those rules or supply the document store.

### Connect the Callers

Put the three interactions in a record. They're now the shared vocabulary for
the editor, the CLI, and the assistant:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#interactions -->
```ts
export const reviewInteractions = {
  read: readDocument,
  suggest: suggestChange,
  accept: acceptSuggestion,
};
```

The excerpts below connect these declarations to the
[application's handlers](./examples/snippets/typescript/document-review-host.ts).

<!-- snippet:examples/snippets/typescript/document-review.ts#imports -->
```ts
import { createReviewApplication } from "./document-review-host";
import type { ReviewActor } from "./document-review-store";
import {
  admitWhen, bindProjection, compileInteractions, direct,
  directRealizationIds, implementInteractions, installInteractions, projectInteractions,
} from "@foxworth/boundary";
```

Select the actions each caller needs from the same declarations. A selected
interface is a **Projection**. The CLI and the assistant can share one,
because both read and suggest. The editor also needs to accept.

<!-- snippet:examples/snippets/typescript/document-review.ts#surfaces -->
```ts
const compiled = compileInteractions(reviewInteractions);
const editorSurface = projectInteractions(compiled, {
  read: direct(compiled.handles.read),
  suggest: direct(compiled.handles.suggest),
  accept: direct(compiled.handles.accept),
});
const contributorSurface = projectInteractions(compiled, {
  read: direct(compiled.handles.read),
  suggest: direct(compiled.handles.suggest),
});
```

An **Installation** pairs the declarations with this application's live
implementations. The application below owns one document and its suggestions:

<!-- snippet:examples/snippets/typescript/document-review.ts#installation -->
```ts
const application = createReviewApplication();
const implementations = implementInteractions<typeof reviewInteractions, ReviewActor>(reviewInteractions, {
  read: application.handlers.read,
  suggest: application.handlers.suggest,
  accept: application.handlers.accept,
});
const { installation } = installInteractions(compiled, {
  installationId: "review:local:1",
  implementations,
  realizationIds: directRealizationIds(compiled, "release-1"),
});
```

A **Binding** checks that the whole selected interface can be served by that
installation. The host also supplies admission rules, checked on every call:

<!-- snippet:examples/snippets/typescript/document-review.ts#connections -->
```ts
const editorResult = bindProjection(editorSurface, installation, {
  admit: admitWhen((actor: ReviewActor) => actor.kind === "editor", "Editor required"),
});
const contributorResult = bindProjection(contributorSurface, installation, {
  admit: admitWhen(
    (actor: ReviewActor) => actor.kind === "script" || actor.kind === "assistant",
    "Contributor required",
  ),
});
if (editorResult.status !== "bound" || contributorResult.status !== "bound") {
  throw new Error("Review interfaces are unavailable");
}
const editor = editorResult.binding.connect();
const contributor = contributorResult.binding.connect();
```

A Projection is the selected caller interface; a Binding is its checked attachment to an Installation, and `connect()` comes after a successful bind.

These fixture identities stand in for authenticated callers. In a remote app,
the server builds them from trusted authentication. Labels a caller supplies
are not permission.

<!-- snippet:examples/snippets/typescript/document-review.ts#actors -->
```ts
// Local fixture identities. A remote host derives these from authentication.
const editorActor: ReviewActor = { id: "alex", kind: "editor" };
const scriptActor: ReviewActor = { id: "review-cli", kind: "script" };
const assistantActor: ReviewActor = { id: "assistant", kind: "assistant" };
```

Now the CLI and the assistant suggest different dates. The editor picks one:

<!-- snippet:examples/snippets/typescript/document-review.ts#review -->
```ts
const original = await contributor.call(contributorSurface.handles.read, {}, scriptActor);
await contributor.call(contributorSurface.handles.suggest, {
  id: "cli-1", text: "Launch on Monday.", basedOnRevision: original.revision,
}, scriptActor);
const suggestion = await contributor.call(contributorSurface.handles.suggest, {
  id: "assistant-1", text: "Launch on Tuesday.", basedOnRevision: original.revision,
}, assistantActor);
// The document is still "Launch on Friday." Both changes are suggestions.

const accepted = await editor.call(editorSurface.handles.accept, {
  suggestionId: suggestion.id,
}, editorActor);
// accepted: { text: "Launch on Tuesday.", revision: 1 }
```

Can the assistant call `accept`? Its connection has no such interaction.
Passing it an editor's handle doesn't expand the connection. Calling through
the editor's connection with an assistant identity fails admission.

The application separately checks that an editor can't accept their own
suggestion, or accept one based on an old revision. Selection, admission, and
domain rules each do a different job.

### Change One Thing. Predict What Still Works.

Suppose you replace the implementation. The selected interactions still mean
read, suggest, and accept, with the same declared contracts. You can
explicitly bind the existing caller interface to the new installation.
Existing connections stay attached to the original installation.

Now suppose a replacement declares that `suggest` also changes the document.
Its name, input, and output are unchanged. Should the assistant's existing
interface still connect?

```text
caller expects          installation declares       bind result

suggestions             suggestions                 bound
suggestions             suggestions + document      unrealized: incompatible-contract
```

Boundary refuses the second binding before running any interaction. The
expected write footprint changed. A check of only the function's name and data
shapes would miss that.

This checks declared agreement. It can't prove an implementation obeys its
declared footprint, or that a suggestion improves the writing.

The [complete example](./examples/snippets/typescript/document-review.ts) and
[its tests](./tests/typescript/document-review-docs.test.ts) exercise the
review, the refusals, and the explicit replacement. They use local calls and
in-memory state. The [caller guide](./docs/guides/adding-a-caller.md) explains
the extra transport step for a real CLI, browser, or agent connection.

## When to Use It

Use Boundary when an application's actions need to survive changes in caller,
implementation, or deployment. An editor, developer tool, framework, or
service can keep its own model while giving each caller a checked interface to
it. A private helper whose callers and implementation always change together
can stay an ordinary function.

Other reasons to make the agreement explicit:

- [Investigate a support ticket, then review its resolution](./docs/guides/next-domains.md#triage): callers work through application-owned review and revision rules.
- [Load a plugin implementation](./docs/guides/plugins.md): keep the interaction declaration with the host while another language supplies the implementation.
- [Publish with evidence of completion](./docs/guides/controlled-effects.md): add explicit approval, execution, verification, and reconciliation when a returned value isn't enough.

The document review above uses ordinary application rules. Consequential
effects can use [Boundary Control](./docs/guides/controlled-effects.md). There, an ambiguous outcome stays uncertain
until the host reconciles it, without permission to repeat the effect.

## Install (Not Yet Published)

Boundary is not published to npm or crates.io yet.
[Availability and support](./docs/concepts/current-status.md) records the
release boundary. For now, work from a checkout of this repository.

### Run the Example

From the checkout, after installing Node 26.13.0, pnpm 12.11.2, Rust 1.100.0,
and the dependencies:

```console
pnpm exec vitest run --config config/vitest.config.ts tests/typescript/document-review-docs.test.ts
```

### Use Boundary in Another Project

Until the package is published, a sibling project installs a packed snapshot
from this checkout, not the workspace source:

In this checkout:

```console
just pack
```

In your project, substitute the Boundary checkout path, the reported package
version, the full tarball SHA-256 without its `sha256:` prefix, and the
`peerDependencies.zod` range from the generated package manifest (`^4.6.5`
in this tree):

```console
mkdir -p vendor/boundary/<SHA256_HEX>
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz vendor/boundary/<SHA256_HEX>/
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz.receipt.json vendor/boundary/<SHA256_HEX>/
pnpm add "file:vendor/boundary/<SHA256_HEX>/foxworth-boundary-<VERSION>.tgz" "zod@<ZOD_PEER_RANGE>"
```

`just pack` runs in this checkout. `pnpm add` runs in your project, after you
copy the packed tarball and receipt into its `vendor/boundary/<SHA256_HEX>/` directory.
[Use Boundary locally](./docs/guides/local-consumers.md) covers that copy,
verifying the installed bytes, peers, and bundling rules for applications and
reusable libraries.

## Learn More

- [The model and guides](./docs/README.md): framework integrations, package
  references, and the independent native Rust implementation.
- Native C and C++ hosts: the [embedding guide](./docs/guides/native-embedding.md).
- The [WebSocket Todo room](./examples/apps/typescript/websocket-room/README.md)
  is a local demo where a streaming assistant looks up tools as it goes and
  proposes completing a todo for host-owned, on-screen approval. On reconnect,
  it replays a stored reply without rerunning the model or the approved action.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
