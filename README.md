# Boundary

**Describe your application's actions once. Slice, verify, and compose checked interfaces for every caller—UIs, CLIs, plugins, and AI agents.**

An application usually starts with ordinary functions: `read`, `suggest`, `accept`, `delete`. When there is only one caller, functions are enough. Then you add a web UI, a CLI, a worker, and an AI assistant—and suddenly you are rebuilding permissions, tool schemas, cache invalidations, and approval flows at every seam.

The root cause is simple: **ordinary functions are opaque.** You can call a function, and that is all you can do with it.

Boundary makes one shift: **separate what an action promises from the code that runs it.** Write the action down as an inspectable value—its name, input, output, errors, what it reads, and what it changes:

```text
search                          delete
  takes:    a query               takes:    a document ID
  returns:  matching documents    returns:  deletion result
  reads:    documents             changes:  documents
```

Look at those last lines. They already form a graph:

```text
delete ── changes ──→ documents ←── reads ── search
```

Just as moving from arithmetic to algebra turns concrete calculations into symbols you can transform and prove things about, turning opaque functions into inspectable **Interactions** unlocks every hard multi-caller problem as a checkable operation on the *same* description—**before a single line of application code runs.**

> **Status:** Boundary has a zero-dependency TypeScript SDK (`@foxworth/boundary`) and an independent native Rust implementation (`boundary-core`). Neither is published to npm or crates.io yet; see [Run It Locally](#run-it-locally).

---

## 30 Seconds of Real Code

Here is a document review workflow with three actions (`read`, `suggest`, `accept`) shared by an editor and an AI assistant.

First, declare the actions with Boundary's built-in zero-dependency schema builder `b` *(already using Zod? Pass `z.strictObject(...)` directly—same portable contract)*:

<!-- snippet:examples/snippets/typescript/document-review-interactions.ts#hero-interactions -->
```ts
import { b, defineInteraction, type InferSchema } from "@foxworth/boundary";

const Document = b.object({ text: b.string(), revision: b.integer({ minimum: 0 }) });
export const Suggestion = b.object({
  id: b.string({ minLength: 1 }),
  text: b.string({ minLength: 1 }),
  basedOnRevision: b.integer({ minimum: 0 }),
});
export const reviewRejected = b.object({ reason: b.string() });

export const reviewInteractions = {
  read: defineInteraction({
    id: "document.read",
    output: Document,
    reads: ["document"],
  }),
  suggest: defineInteraction({
    id: "document.suggest",
    input: Suggestion,
    output: Suggestion,
    errors: { reviewRejected },
    reads: ["document", "suggestions"],
    changes: ["suggestions"],
  }),
  accept: defineInteraction({
    id: "document.accept",
    input: b.object({ suggestionId: b.string() }),
    output: Document,
    errors: { reviewRejected },
    reads: ["document", "suggestions"],
    changes: ["document", "suggestions"],
  }),
} as const;
```

Next, pair those declarations with your ordinary [application handlers](./examples/snippets/typescript/document-review-host.ts) and slice a checked interface for each caller. Setup is **pure and synchronous**—no `await`, no framework lock-in:

<!-- snippet:examples/snippets/typescript/document-review.ts#hero-host -->
```ts
const host = createHost(reviewInteractions, {
  installationId: "review:local:1",
  realizationVersion: "release-1",
  handlers: application.handlers,
  callers: {
    editor: {
      direct: ["read", "suggest", "accept"],
      admit: (actor: ReviewActor) => actor.kind === "editor",
    },
    assistant: {
      direct: ["read", "suggest"], // no `accept` — absent at compile time and runtime
      admit: (actor: ReviewActor) => actor.kind === "assistant",
    },
  },
});
```

Now both callers work against the same document—and `tryCallers` returns exhaustive, typed outcomes (`ok`, `declared-error`, `denied`, `fault`) instead of untyped exceptions:

<!-- snippet:examples/snippets/typescript/document-review.ts#hero-calls -->
```ts
const doc = await host.callers.assistant.read(assistantActor);
const proposal = await host.callers.assistant.suggest(
  { id: "s1", text: "Launch on Tuesday.", basedOnRevision: doc.revision },
  assistantActor,
);
// Document still says "Launch on Friday." — only suggestions changed.

const outcome = await host.tryCallers.editor.accept(
  { suggestionId: proposal.id },
  editorActor,
);
if (outcome.kind === "ok") {
  return outcome.value; // { text: "Launch on Tuesday.", revision: 1 }
}
throw new Error(`Accept did not complete: ${outcome.kind}`);
```

Can the assistant call `accept`? No—`accept` is not on its interface at compile time or runtime, and calling through the editor's connection with an assistant identity fails admission before any handler runs. Your application's own [store and rules](./examples/snippets/typescript/document-review-store.ts) still decide revision checks and self-review bans.

---

## Why One Idea Unlocks Four Things

Every piece of Boundary follows from treating interactions as inspectable values. Each concept below earns its name only when a real problem demands it.

### 1. Slice interfaces like sets (`Program` → `Projection`)

Suppose a CLI, an assistant, a web editor, and a plugin all need different slices of the same application—and you want to describe or inspect those interfaces *before* any server or handler is running.

Compiling your definitions produces a deterministic **Program**. From it, you carve out caller interfaces—**Projections**—using ordinary set operations (`pick`, `omit`, `union`, `intersect`):

<!-- snippet:examples/snippets/typescript/document-review.ts#algebra -->
```ts
const compiled = compileInteractions(reviewInteractions);

const editorSurface = compiled.projectAll("direct");
const contributorSurface = pickProjection(editorSurface, "read", "suggest");
// Pure, synchronous values — no handlers or runtime required yet.
```

```text
assistant's Projection              your application
┌─────────────────────┐
│ read, suggest       │──────────┐
└─────────────────────┘          │   ┌──────────────────────┐
                                 ├──▶│ read, suggest        │
editor's Projection              │   │ accept               │
┌─────────────────────┐          │   └──────────────────────┘
│ read, suggest       │──────────┘
│ accept              │──────────────▶ accept (editor only)
└─────────────────────┘
```

Projections carry no handlers, no credentials, and no transport. They are portable data you can diff, serialize, expose over HTTP/MCP, or share across TypeScript and Rust.

### 2. Catch contract drift before line 1 runs (`Installation` + `Binding`)

When live handlers are ready, you wrap them in an **Installation** (pairing each handler with its realization ID via `realizeDirect`) and atomically connect a Projection with `bindProjection`.

Now imagine someone changes `suggest` so it silently mutates `document` too. Its name, input, and output types are identical. Should the assistant's existing interface still connect?

```text
caller expects          installation declares       bind result

changes: suggestions    changes: suggestions        bound
changes: suggestions    changes: suggestions + doc  unrealized: incompatible-contract
```

Boundary refuses the second **Binding** before a single handler runs. Binding is **atomic** over the whole surface—never a half-connected caller—and **explicit**: existing connections stay pinned to the old installation until you rebind (or swap atomically via `createBindingSlot`).

> **Be clear about what this proves:** Contract checks catch declared drift before launch. They cannot prove that a handler obeys its declared footprint or produces good results—that remains the job of your application tests and `@foxworth/boundary/testing`.

### 3. Compute from the `reads` / `changes` graph (Live Views + `Plan`s)

Because every interaction declares what it reads and changes—globally (`"document"`) or scoped per record (`"document:{input.id}"`)—two capabilities fall straight out of the same graph:

- **Truthful view refresh:** When `accept` changes `document`, Boundary's observation and client cache layers know every mounted `read` that depends on `document` and refresh it—whether the change came from the editor, a CLI, or an agent. See [shared updates](./docs/guides/humans-and-agents.md#make-shared-updates-truthful).
- **Handler-free `Plan`s (`@foxworth/boundary/plan`):** Represent a multi-step agent or UI workflow as a static DAG over interactions. Before step 1 executes, Boundary derives the minimal Projection the plan needs, splits independent steps into parallel waves by disjoint footprints, and **atomically preflights** every step against a live Binding.

### 4. Propose instead of act—and stay honest about uncertainty (`Control`)

What if an assistant should help clean up old documents, but never delete one directly? For consequential actions, Boundary's optional **Control** layer separates **direct** execution from **request** mode:

```text
direct mode  → perform the action, if admitted
request mode → prepare a reviewable proposal (never executes the effect)
```

```text
assistant                 application
request delete ─────────▶ prepare proposal ─▶ approve ─▶ grant ─▶ attempt ─▶ apply ─▶ verify
                                                                      │
                                                            connection drops?
                                                                      ▼
                                                            uncertain ─▶ reconcile
```

And if a connection drops mid-effect? Claiming failure invites a duplicate charge or delete; claiming success invents evidence. Boundary records the outcome honestly as **`uncertain`** (and `certainty: "unknown"` on direct faults) until your host reconciles against reality—never silently retrying a side effect.

---

## The Whole Model in One Picture

```text
Interaction definitions ──▶ Program ──▶ Projection (selected surface)
                                             │
                                  atomic contract check
                                             │
Application handlers    ──▶ Installation ────┴──▶ Binding ──▶ Caller (direct / try / request)
                                                                 │
                                                      admission per call
                                                                 │
                                                       your code runs here
```

**When to use Boundary:** Use it at seams that need to survive changes in caller, implementation, or deployment—UIs, CLIs, AI agents, plugins, workers, and multi-process hosts. Keep private helpers whose callers and code always change together as ordinary functions.

---

## Two Native Implementations, Zero Lock-In

- **TypeScript (`@foxworth/boundary`):** Zero runtime dependencies; works in Node, browsers, Cloudflare Workers, Bun, Deno, and Electron. Built-in `b.*` schemas or Zod. First-party subpaths for HTTP, MCP, WebMCP, React, Hono, Next, tRPC, Vite, Cloudflare, Electron, WASM plugins, Plans, and contract testing. *(Experimental read-only Yjs and Automerge snapshot adapters are also included; see [availability and support](./docs/concepts/current-status.md).)*
- **Rust (`boundary-core` + `boundary-ffi`):** Independent native Rust implementation—no JS runtime, no wrapper—cross-checked against shared JSON conformance vectors, with a C ABI for C/C++ hosts.

Both implementations agree on the portable contract, digest, projection, plan, and control laws while letting each language stay idiomatic.

---

## Run It Locally

Boundary is not published to npm or crates.io yet (see [availability and support](./docs/concepts/current-status.md)).

### Run the README example

From this checkout (Node 26.13.0, pnpm 12.11.2, Rust 1.100.0):

```console
pnpm exec vitest run --config config/vitest.config.ts tests/typescript/document-review-docs.test.ts
```

The [complete example](./examples/snippets/typescript/document-review.ts) and [its tests](./tests/typescript/document-review-docs.test.ts) exercise the hero workflow, refusal of unselected actions, admission checks, explicit replacement, and contract-drift rejection.

### Use Boundary in another project

Until publication, pack a verified snapshot from this checkout and install it into your project:

```console
# 1. In this checkout:
just pack

# 2. In your project (substitute <VERSION>, <SHA256_HEX>, and optional zod peer if used):
mkdir -p vendor/boundary/<SHA256_HEX>
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz vendor/boundary/<SHA256_HEX>/
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz.receipt.json vendor/boundary/<SHA256_HEX>/
pnpm add "file:vendor/boundary/<SHA256_HEX>/foxworth-boundary-<VERSION>.tgz"
```

See [Use Boundary locally](./docs/guides/local-consumers.md) for digest verification, optional peers (like `zod`), and library bundling rules.

---

## Where to Go Next

| Goal | Start here |
| --- | --- |
| Understand the model deeply (interactive walkthrough) | [Why interactions?](./docs/concepts/interaction-first-programming.md) · [Build the thumbnail tool](./docs/guides/getting-started.md) |
| Shortest native TypeScript setup (`createHost`) | [Concise authoring](./docs/guides/concise-authoring.md) |
| Add an HTTP API, CLI, React UI, or AI agent (MCP/WebMCP) | [Adding a caller](./docs/guides/adding-a-caller.md) · [Humans and agents](./docs/guides/humans-and-agents.md) |
| Add proposals, approvals, and crash reconciliation | [Controlled effects](./docs/guides/controlled-effects.md) |
| Run plugins in other languages (WASM) | [Load a plugin](./docs/guides/plugins.md) |
| Static multi-step Plans & preflight | [Plans specification](./docs/spec/07-plans.md) |
| Native Rust crate & C/C++ embedding | [Rust reference](./docs/reference/rust.md) · [Native embedding](./docs/guides/native-embedding.md) |
| See a full streaming agent + approval demo | [WebSocket Todo room](./examples/apps/typescript/websocket-room/README.md) · [Triage & studio](./docs/guides/next-domains.md#triage) |
| Browse every guide, package reference, and spec | [Documentation index](./docs/README.md) |

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
