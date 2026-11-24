---
title: "Add another caller"
description: "Select a caller surface, connect it to an installation, and supply invocation context."
---

# Add another caller

A new caller should reuse existing interaction declarations. Its integration
work is selecting the required surface, connecting it to an installation, and
supplying the invocation context the host needs.

Start with the [thumbnail walkthrough](./getting-started.md) if you do not yet
have an installation. The snippets below continue inside `createThumbnailExample`
in the [complete example](../../examples/snippets/typescript/thumbnail.ts), using its interaction
definitions, imports, installation, and `Context` type. The fixture creates a
thumbnail from a generated SVG in memory; it does not process uploaded photographs.

## Select the work this caller needs

The image editor uses inspection, thumbnail creation, and deletion. A nightly
script only makes thumbnails.

```text
editor: [ inspect, makeThumbnail, delete ]
script: [          makeThumbnail         ]
```

Create the script's Projection from compiled declarations. It needs no running
installation or admission context at this stage. Select required interactions
and modes explicitly; avoid giving it a larger surface merely because the
editor already has one.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#projection -->
```ts
const compiled = compileInteractions(interactions);
const thumbnailSurface = projectInteractions(compiled, {
  makeThumbnail: direct(compiled.handles.makeThumbnail),
});
// No implementation or live installation is needed to select this surface.
```

## Bind to available execution

When an installation is available, bind the Projection with the host's
admission function. Inspect an `unrealized` report instead of continuing with
only the interactions that happened to match. A successful Binding connects the
whole selected surface and pins its implementation mapping. The example keeps
the exhaustive report as the thrown error's `cause`; inspect its `issues` for
the alias, interaction, mode, reason, and contract path that blocked connection.

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

Supply context on each invocation. The host uses that context for admission
and execution; the application is responsible for authenticating callers and
constructing trustworthy context.

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

Both calls select the same handle and supply different invocation context.

If the worker returns a job ID where the script expects a finished thumbnail,
fix the declared workflow deliberately. Rebinding cannot turn incompatible
results into the expected output.

## Attach the interface

A native caller can use the typed Caller. HTTP, MCP, WebMCP, and other adapters
translate their interface into the selected bound interactions. Cross-process
calls require the appropriate Handoff integration; a local Binding does not
create a remote transport.

Presentation names can differ from interaction IDs. There is no way to hide a
bound interaction from a tool list: the list presents the whole Binding. When an
interaction must be outside this caller's surface, bind a narrower Projection.

## Check the boundary

Verify these behaviors for the new integration:

- Selected interactions reach the pinned implementation.
- Missing or incompatible required interactions prevent the whole binding.
- Unselected interactions, wrong modes, invalid inputs, and admission denial do
  not dispatch.
- Admission and execution receive the intended invocation context.
- Invalid outputs and declared errors are handled at the contract boundary.
- Revocation prevents future execution; a replacement installation requires
  an explicit new connection.

See [testing](./testing.md) for the broader verification guide.

## Give an agent the same treatment

An agent preparing article images selects inspection and thumbnail creation.
Deletion stays outside its Projection. Its tool interface describes those
existing interactions, and the host still admits each invocation.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#agent -->
```ts
const agentSurface = projectInteractions(compiled, {
  makeThumbnail: direct(compiled.handles.makeThumbnail),
  inspectImage: direct(compiled.handles.inspectImage),
});
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

There is no new interaction model merely because the caller is an agent. If a
particular effect needs approval, expose the appropriate request mode through
[Control](./controlled-effects.md); a request does not execute the
effect.
