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

Create the script's Surface from the declarations. It needs no running
installation or admission context at this stage. Select required interactions
and modes explicitly; avoid giving it a larger surface merely because the
editor already has one.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#surface -->
```ts
const thumbnailSurface = surface(interactions, { call: ["makeThumbnail"] });
// No implementation or live installation is needed to select this surface.
```

## Connect to available execution

When an installation is available, connect the Surface with the host's
admission function. A successful connection binds the whole selected surface
and pins its implementation mapping; there is no caller over the interactions
that happened to match. When the surface cannot be realized, `connect` throws a
`ConnectError` whose `report.issues` name the alias, interaction, mode, reason,
and contract path that blocked connection, and whose `expected`, `found`, and
`fix` text say what to change.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#connect -->
```ts
const admitScreenOrScript = admitWhen(
  (context: Context) => context.kind === "screen" || context.kind === "script",
  "This connection admits the screen and script",
);
const thumbnails = await app.connect(thumbnailSurface, { admit: admitScreenOrScript });
```

Supply context on each invocation. The host uses that context for admission
and execution; the application is responsible for authenticating callers and
constructing trustworthy context.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#call -->
```ts
const fromScreen = () => thumbnails.makeThumbnail(
  { imageId: "original", maxWidth: 200 },
  { kind: "screen" },
);
const fromScript = () => thumbnails.makeThumbnail(
  { imageId: "original", maxWidth: 200 },
  { kind: "script" },
);
```

Both calls use the same method and supply different invocation context.

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
interaction must be outside this caller's surface, connect a narrower Surface.

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
Deletion stays outside its Surface. Its tool interface describes those
existing interactions, and the host still admits each invocation.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#agent -->
```ts
const agentSurface = surface(interactions, { call: ["makeThumbnail", "inspectImage"] });
const agent = await app.connect(agentSurface, {
  admit: admitWhen((context: Context) => context.kind === "agent", "Agent connection required"),
});
// No deleteImage method exists. Admission still checks every call.
// Context must come from the host's trusted caller identification.
```

There is no new interaction model merely because the caller is an agent. If a
particular effect needs approval, expose the appropriate request mode through
[Control](./controlled-effects.md); a request does not execute the
effect.
