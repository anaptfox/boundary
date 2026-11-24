---
title: "Add another caller"
description: "Slice a narrow surface for a new caller, bind it atomically, and connect it over a transport."
---

# Add another caller

Adding a new caller—a CLI, a scheduled script, a browser UI, or an AI agent—should never mean redefining your application's actions. You reuse the existing compiled interactions and do three things: **slice the surface**, **bind it atomically**, and **supply authenticated context per call**.

*(The snippets below continue from [Build a thumbnail tool](./getting-started.md) and match [examples/snippets/typescript/thumbnail.ts](../../examples/snippets/typescript/thumbnail.ts).)*

## 1. Slice only what this caller needs

The editor can inspect, resize, and delete images. A nightly script only resizes:

```text
editor: [ inspectImage, makeThumbnail, deleteImage ]
script: [               makeThumbnail              ]
```

Carve out the script's **Projection** synchronously from the compiled Program. Resist reusing the editor's larger surface out of convenience—narrowing here is enforced everywhere downstream:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#projection -->
```ts
const compiled = compileInteractions(interactions);
const allDirect = compiled.projectAll("direct");
const thumbnailSurface = pickProjection(allDirect, "makeThumbnail");
// Pure, synchronous values — no implementation or live installation needed yet.
```

## 2. Bind atomically and supply trusted context

Connect that Projection to a live Installation with an admission check. If any selected interaction is missing or incompatible, `bindProjection` fails atomically and returns an exhaustive `report.issues`—never a half-connected caller:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#binding -->
```ts
const admitScreenOrScript = admitWhen(
  (context: Context) => context.kind === "screen" || context.kind === "script",
  "This connection admits the screen and script",
);
const result = bindProjection(thumbnailSurface, installation, {
  admit: admitScreenOrScript,
});
if (result.status !== "bound") {
  throw new Error("Thumbnail surface is unavailable", { cause: result.report });
}
const caller = result.binding.connect();
```

Supply fresh, host-authenticated context on every invocation *(if you want admission to return a narrowed typed auth object that flows straight into handlers and observed reads, use `bindAuthorizedProjection`)*:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#call -->
```ts
const fromScreen = () => caller.call(
  thumbnailSurface.handles.makeThumbnail,
  { imageId: "original", maxWidth: 200 },
  { kind: "screen" },
);
const fromScript = () => caller.call(
  thumbnailSurface.handles.makeThumbnail,
  { imageId: "original", maxWidth: 200 },
  { kind: "script" },
);
```

## 3. Attach a transport or UI adapter

- **In-process:** Use the typed Caller directly (`caller.call(...)`, `caller.direct.*`, or exhaustive `caller.try.*`).
- **Over the network / across processes:** Pass the Binding to an adapter—`@foxworth/boundary/http`, `@foxworth/boundary/mcp`, `@foxworth/boundary/webmcp`, `@foxworth/boundary/electron`, or your own transport over `@foxworth/boundary/handoff`.

One crucial rule: **adapters present the entire Binding.** There is no adapter-level "hide this tool" flag. If a caller shouldn't see an action, bind a narrower Projection—so what is hidden and what is unenforceable can never drift apart.

## 4. Give an AI agent the exact same treatment

An agent preparing article images needs inspection and thumbnail creation, never deletion:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#agent -->
```ts
const agentSurface = pickProjection(allDirect, "makeThumbnail", "inspectImage");
const agentResult = bindProjection(agentSurface, installation, {
  admit: admitWhen((context: Context) => context.kind === "agent", "Agent connection required"),
});
if (agentResult.status !== "bound") {
  throw new Error("Agent surface is unavailable", { cause: agentResult.report });
}
const agent = agentResult.binding.connect();
// No deleteImage handle is exposed. Admission still checks every call.
// Context must come from the host's trusted caller identification.
```

No second execution model is needed just because the caller is an agent. And if an action requires human review before executing, expose it in `request` mode with [Controlled effects](./controlled-effects.md).

## 5. Checklist before shipping a new caller

Verify these behaviors in tests (see [Testing the seams](./testing.md)):
- Selected interactions dispatch to the pinned realization.
- Missing or incompatible contracts refuse the entire Binding with zero dispatches.
- Unselected interactions, wrong modes, invalid inputs, and denied actors never reach handlers.
- Revoking the Binding or Installation blocks subsequent calls cleanly.
- Replacing an Installation either creates a fresh Binding explicitly or swaps atomically through `createBindingSlot`.
