---
title: "Build a thumbnail tool, then change it"
description: "Run a thumbnail tool, replace an implementation, and see which connections still hold."
---

# Build a thumbnail tool, then change it

Start with a button and a script that both make a thumbnail. Connect the same
caller surface to a replacement installation. Then predict what happens when
an implementation returns a job ID instead of a finished thumbnail. Add an
agent at the end.

```text
button ──┐
         ├── make thumbnail ──> [ 200 × 150 image ]
script ──┘
```

The complete [executable example](../../examples/snippets/typescript/thumbnail.ts) generates
a small SVG in memory. It uses the same geometry as resizing a photograph,
without requiring uploads, an image decoder, a database, or a worker service.
The [tests](../../tests/typescript/thumbnail-docs.test.ts) execute the calls and
check the resulting SVG and refusal behavior.

From this checkout, run:

```console
pnpm exec vitest run tests/typescript/thumbnail-docs.test.ts
```

The packages are unpublished; see [availability](../concepts/current-status.md).
Every TypeScript fence below is synchronized with the executable source.
The source groups the setup inside `createThumbnailExample()`; use that file
as the runnable version while following its parts here.

## 1. State what making a thumbnail means

A caller supplies an image ID and a maximum width. It expects the resulting
image ID and dimensions. This interaction also declares which application state
it reads and changes.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#thumbnail-contract -->
```ts
import { z } from "zod";
import { defineInteraction } from "@foxworth/boundary";

const ThumbnailInput = z.strictObject({
  imageId: z.string(),
  maxWidth: z.number().int().positive(),
});
const ImageInfo = z.strictObject({
  imageId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const makeThumbnailInteraction = defineInteraction({
  id: "images.makeThumbnail",
  input: ThumbnailInput,
  output: ImageInfo,
  reads: ["images"],
  changes: ["images"],
});
```

An interaction definition contains no renderer or store. Changing the button
that invokes it does not change this contract.

The image application also has inspection and deletion interactions:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#definitions -->
```ts
export const interactions = {
  makeThumbnail: makeThumbnailInteraction,
  inspectImage: defineInteraction({
    id: "images.inspect",
    input: z.strictObject({ imageId: z.string() }),
    output: ImageInfo,
    reads: ["images"],
  }),
  deleteImage: defineInteraction({
    id: "images.delete",
    input: z.strictObject({ imageId: z.string() }),
    output: z.strictObject({ deleted: z.boolean() }),
    changes: ["images"],
  }),
};
```

## 2. Keep rendering in ordinary application code

These types and SVG helper belong to the example application:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#application -->
```ts
type Context = Readonly<{ kind: "screen" | "script" | "agent" }>;
type StoredImage = z.infer<typeof ImageInfo> & { svg: string };
const content = '<rect width="800" height="600" fill="coral"/>'
  + '<circle cx="400" cy="300" r="180" fill="navy"/>';
function svg(width: number, height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 600">${content}</svg>`;
}
```

Inside `createThumbnailExample()`, the application creates its store and renderer:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#rendering-storage -->
```ts
const images = new Map<string, StoredImage>([
  ["original", { imageId: "original", width: 800, height: 600, svg: svg(800, 600) }],
]);
const dispatches: string[] = [];
function lookup(imageId: string) {
  const found = images.get(imageId);
  if (!found) throw new Error(`Unknown image: ${imageId}`);
  return found;
}
// Application-owned rendering remains an ordinary function.
function makeThumbnail(input: z.infer<typeof ThumbnailInput>) {
  const original = lookup(input.imageId);
  const width = Math.min(original.width, input.maxWidth);
  const height = Math.max(1, Math.round(original.height * width / original.width));
  const imageId = `${input.imageId}:w${width}`;
  images.set(imageId, { imageId, width, height, svg: svg(width, height) });
  return { imageId, width, height };
}
```

Both a button and script could call this function directly. Shared functions
work well while the callers and implementation change together. Boundary becomes
useful when they need to exchange an explicit contract and connect independently.

## 3. Select what the caller needs

Import the remaining Host functions used in the setup:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#imports -->
```ts
import { admitWhen, install, surface } from "@foxworth/boundary";
```

Inside the same async setup, select thumbnail creation for our two initial
callers:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#surface -->
```ts
const thumbnailSurface = surface(interactions, { call: ["makeThumbnail"] });
// No implementation or live installation is needed to select this surface.
```

```text
caller needs                   application declares
[ makeThumbnail ]              [ makeThumbnail, inspect, delete ]
```

The selection is a **Surface**. At this point, there is still no live
connection. It can exist before any implementation is installed.

## 4. Supply the implementation

Pair the definitions with application code, then install it. An **Installation**
is the live host that makes those implementations available.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#installation -->
```ts
const handlers = {
  makeThumbnail(input: z.infer<typeof ThumbnailInput>, _context: Context) {
    dispatches.push("makeThumbnail");
    return makeThumbnail(input);
  },
  inspectImage({ imageId }: { imageId: string }) {
    dispatches.push("inspectImage");
    const { width, height } = lookup(imageId);
    return { imageId, width, height };
  },
  deleteImage({ imageId }: { imageId: string }) {
    dispatches.push("deleteImage");
    return { deleted: images.delete(imageId) };
  },
};
const app = await install(interactions, {
  id: "images:local:release-1",
  version: "release-1",
  handlers,
});
```

The host supplies the installation id and the `version`. The version
identifies the declared implementation revision; it is not a hash of function
source or proof of correct rendering. A different deployment needs deliberate
host identity and lifecycle choices.

## 5. Check the connection, then call

Predict the result: our surface requires thumbnail creation, and this
installation provides it. Boundary connects them if their contracts and modes
agree, and throws a `ConnectError` carrying the exhaustive report otherwise.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#connect -->
```ts
const admitScreenOrScript = admitWhen(
  (context: Context) => context.kind === "screen" || context.kind === "script",
  "This connection admits the screen and script",
);
const thumbnails = await app.connect(thumbnailSurface, { admit: admitScreenOrScript });
```

```text
required: makeThumbnail ── checked ── available: makeThumbnail
                              |
                            bound
```

The caller's **Binding** pins this complete selected surface to this
installation. Admission still checks each invocation. In this local example the context is
constructed by the application; a remote host must authenticate callers before
creating trusted context.

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

Calling `fromScreen()` and `fromScript()` both produces
`{ imageId: "original:w200", width: 200, height: 150 }`. Both reach the same
application renderer. The screen and script are represented by these functions;
this fixture does not mount a browser button or scheduler.

## 6. Connect to a replacement explicitly

Keep the required surface fixed and change the installation:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#replacement -->
```ts
// A new local installation, not a remote-worker implementation.
const replacement = await install(interactions, {
  id: "images:local:release-2",
  version: "release-2",
  handlers,
});
// The same caller surface connects explicitly to the new installation.
const replacementCaller = await replacement.connect(thumbnailSurface, { admit: admitScreenOrScript });
```

```text
same Surface ── old Binding ── release-1
                └─ new Binding ── release-2
```

The fixture reuses the renderer in a second local installation. This demonstrates
explicit replacement binding, not remote execution or automatic failover. A real
worker additionally needs a [host-chosen transport](./adding-a-caller.md).
The old Binding does not silently move to the new installation.

## 7. Predict a broken agreement

Now change only the offered output contract. A queued implementation returns a
job ID, while our callers expect a completed thumbnail. Will connecting succeed?

<!-- snippet:examples/snippets/typescript/thumbnail.ts#mismatch -->
```ts
const queuedInteractions = {
  makeThumbnail: defineInteraction({
    id: "images.makeThumbnail",
    input: ThumbnailInput,
    output: z.strictObject({ jobId: z.string() }),
    reads: ["images"],
    changes: ["images"],
  }),
};
const queuedDispatches: string[] = [];
const queued = await install(queuedInteractions, {
  id: "images:queued:release-1",
  version: "release-1",
  handlers: {
    makeThumbnail(_input, _context: Context) {
      queuedDispatches.push("makeThumbnail");
      return { jobId: "job-1" };
    },
  },
});
const mismatch = await queued.tryConnect(thumbnailSurface, { admit: admitScreenOrScript });
// mismatch.status === "unrealized": a job ID does not satisfy ImageInfo.
// Connecting checks declarations without dispatching thumbnail work.
```

```text
caller expects                     installation offers
thumbnail ID + width + height  X    job ID
                              |
                           unrealized
                      zero thumbnail dispatches
```

`mismatch.status` is `unrealized`; `queuedDispatches` stays empty. `tryConnect`
returns the report instead of throwing; inspect `mismatch.report` for the
incompatibility.
Boundary checks declarations here without trial-running the interaction.

A compatible declaration still cannot prove that the image looks good. If a
renderer returns valid dimensions for an ugly image, application tests must
catch that. If it returns an invalid value after starting, the consequence
can be unknown. See [guarantees and counterexamples](../concepts/guarantees.md).

## Finally, add an agent

An agent preparing images for an article needs inspection and thumbnail creation.
Predict which definitions must change before looking at the code.

<!-- snippet:examples/snippets/typescript/thumbnail.ts#agent -->
```ts
const agentSurface = surface(interactions, { call: ["makeThumbnail", "inspectImage"] });
const agent = await app.connect(agentSurface, {
  admit: admitWhen((context: Context) => context.kind === "agent", "Agent connection required"),
});
// No deleteImage method exists. Admission still checks every call.
// Context must come from the host's trusted caller identification.
```

```text
application: [ inspect, makeThumbnail, delete ]
agent:       [ inspect, makeThumbnail         ]
```

The existing definitions stay unchanged. The agent gets its own Surface,
Binding, and admission rule. There is no deletion method or bound deletion
interaction on its surface. The tests also attempt a call with the wrong context
and check that it never dispatches.

This is the Host integration for an agent caller. [MCP and WebMCP adapters](../reference/adapters.md)
can present that surface as tools; registering those transports is a separate step.

For a consequential action, continue with [controlled effects](./controlled-effects.md).
For an existing renderer or framework, use the [native application guides](../README.md#native-application-guides).
