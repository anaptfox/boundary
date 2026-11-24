---
title: "Build a thumbnail tool, then change it"
description: "Run a thumbnail tool, swap implementations, deliberately break a contract, and add an AI agent—without changing a single definition."
---

# Build a thumbnail tool, then change it

Start with a button and a nightly script that both resize an image. Swap in a new implementation explicitly. Deliberately break the contract and watch Boundary catch it before a single handler runs. Then add an AI agent at the end without touching your definitions.

```text
button ──┐
         ├──▶ makeThumbnail ──▶ [ 200 × 150 image ]
script ──┘
```

The complete [executable example](../../examples/snippets/typescript/thumbnail.ts) generates a small SVG in memory—same resizing geometry, zero external setup. Every TypeScript block below is verified directly against that source by [its tests](../../tests/typescript/thumbnail-docs.test.ts).

Run it from this checkout:

```console
pnpm exec vitest run --config config/vitest.config.ts tests/typescript/thumbnail-docs.test.ts
```

*(Boundary packages are not yet published; see [Availability and support](../concepts/current-status.md).)*

## 1. Declare what making a thumbnail promises

Start by lifting the contract out of the renderer. Notice we use Boundary's built-in zero-dependency `b` schema builder—no Zod required *(though `z.strictObject(...)` works directly too)*:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#imports -->
```ts
import {
  admitWhen,
  b,
  bindProjection,
  compileInteractions,
  defineInteraction,
  installInteractions,
  pickProjection,
  realizeDirect,
  type InferSchema,
} from "@foxworth/boundary";
```

<!-- snippet:examples/snippets/typescript/thumbnail.ts#thumbnail-contract -->
```ts
const ThumbnailInput = b.object({
  imageId: b.string(),
  maxWidth: b.integer({ minimum: 1 }),
});
const ImageInfo = b.object({
  imageId: b.string(),
  width: b.integer({ minimum: 1 }),
  height: b.integer({ minimum: 1 }),
});
export const makeThumbnailInteraction = defineInteraction({
  id: "images.makeThumbnail",
  input: ThumbnailInput,
  output: ImageInfo,
  reads: ["images"],
  changes: ["images"],
});
```

There is no renderer, database, or transport in that definition—only what a caller passes in, what it gets back, and which state it touches. Now add `inspectImage` and `deleteImage` to complete the application's vocabulary:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#definitions -->
```ts
export const interactions = {
  makeThumbnail: makeThumbnailInteraction,
  inspectImage: defineInteraction({
    id: "images.inspect",
    input: b.object({ imageId: b.string() }),
    output: ImageInfo,
    reads: ["images"],
  }),
  deleteImage: defineInteraction({
    id: "images.delete",
    input: b.object({ imageId: b.string() }),
    output: b.object({ deleted: b.boolean() }),
    changes: ["images"],
  }),
} as const;
```

## 2. Keep your rendering code completely ordinary

Your app's own types, store, and resizing function don't know Boundary exists:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#application -->
```ts
type Context = Readonly<{ kind: "screen" | "script" | "agent" }>;
type StoredImage = InferSchema<typeof ImageInfo> & { svg: string };
const content = '<rect width="800" height="600" fill="coral"/>'
  + '<circle cx="400" cy="300" r="180" fill="navy"/>';
function svg(width: number, height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 600">${content}</svg>`;
}
```

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
function makeThumbnail(input: InferSchema<typeof ThumbnailInput>) {
  const original = lookup(input.imageId);
  const width = Math.min(original.width, input.maxWidth);
  const height = Math.max(1, Math.round(original.height * width / original.width));
  const imageId = `${input.imageId}:w${width}`;
  images.set(imageId, { imageId, width, height, svg: svg(width, height) });
  return { imageId, width, height };
}
```

## 3. Slice what the caller needs (no handlers yet)

Compile your definitions into a deterministic **Program** and slice a **Projection** containing only `makeThumbnail`. Notice everything here is **pure and synchronous**—no `await`, no running server needed:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#projection -->
```ts
const compiled = compileInteractions(interactions);
const allDirect = compiled.projectAll("direct");
const thumbnailSurface = pickProjection(allDirect, "makeThumbnail");
// Pure, synchronous values — no implementation or live installation needed yet.
```

```text
caller needs                   application declares
[ makeThumbnail ]              [ makeThumbnail, inspectImage, deleteImage ]
```

*(You can also combine projections with `.pick(...)`, `.omit(...)`, `.union(...)`, and `.intersect(...)`.)*

## 4. Install your handlers

Pair each compiled interaction with its handler and an explicit realization ID using `realizeDirect`, creating a live **Installation**:

<!-- snippet:examples/snippets/typescript/thumbnail.ts#installation -->
```ts
const handlers = {
  makeThumbnail(input: InferSchema<typeof ThumbnailInput>) {
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
const { installation } = installInteractions<typeof interactions, Context>(compiled, {
  installationId: "images:local:release-1",
  realizations: {
    makeThumbnail: realizeDirect(handlers.makeThumbnail, "makeThumbnail:release-1"),
    inspectImage: realizeDirect(handlers.inspectImage, "inspectImage:release-1"),
    deleteImage: realizeDirect(handlers.deleteImage, "deleteImage:release-1"),
  },
});
```

Change the realization ID (`"makeThumbnail:release-2"`) whenever your handler's behavior changes; Boundary never hashes function source.

## 5. Check the connection atomically, then call

Now connect `thumbnailSurface` to `installation` with your per-call admission rule. Before anything runs, Boundary checks that every interaction in the Projection is compatibly realized:

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

```text
required: makeThumbnail ── checked ──▶ available: makeThumbnail
                               │
                             bound
```

Invoke through the stateless **Caller**, supplying authenticated context on every call:

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

Both return `{ imageId: "original:w200", width: 200, height: 150 }`. *(Need exhaustive error handling without `try/catch`? Call `caller.try.makeThumbnail(...)` to get a discriminated `ok | declared-error | denied | fault` result, or use [createHost](./concise-authoring.md) for a 15-line shortcut.)*

## 6. Swap in a replacement installation explicitly

Keep `thumbnailSurface` fixed and bind it to a fresh installation (`release-2`):

<!-- snippet:examples/snippets/typescript/thumbnail.ts#replacement -->
```ts
// A new local installation, not a remote-worker implementation.
const { installation: replacement } = installInteractions<typeof interactions, Context>(compiled, {
  installationId: "images:local:release-2",
  realizations: {
    makeThumbnail: realizeDirect(handlers.makeThumbnail, "makeThumbnail:release-2"),
    inspectImage: realizeDirect(handlers.inspectImage, "inspectImage:release-2"),
    deleteImage: realizeDirect(handlers.deleteImage, "deleteImage:release-2"),
  },
});
const replacementResult = bindProjection(thumbnailSurface, replacement, {
  admit: admitScreenOrScript,
});
if (replacementResult.status !== "bound") {
  throw new Error("Replacement cannot satisfy caller", { cause: replacementResult.report });
}
// The same caller surface connects explicitly to the new installation.
const replacementCaller = replacementResult.binding.connect();
```

```text
same Projection ── old Binding ──▶ release-1
                └─ new Binding ──▶ release-2
```

The old Binding stays pinned to `release-1`—it never silently drifts. For long-lived hosts that hot-swap installations safely, wrap the binding in `createBindingSlot`: a failed upgrade leaves the previous live binding intact.

## 7. Now break the contract on purpose

Predict what happens next. A new queued implementation accepts the same `ThumbnailInput`, but returns `{ jobId }` instead of `{ imageId, width, height }`. Should binding succeed?

<!-- snippet:examples/snippets/typescript/thumbnail.ts#mismatch -->
```ts
const queuedInteractions = {
  makeThumbnail: defineInteraction({
    id: "images.makeThumbnail",
    input: ThumbnailInput,
    output: b.object({ jobId: b.string() }),
    reads: ["images"],
    changes: ["images"],
  }),
} as const;
const queued = compileInteractions(queuedInteractions);
const queuedDispatches: string[] = [];
const { installation: queuedInstallation } = installInteractions<typeof queuedInteractions, Context>(queued, {
  installationId: "images:queued:release-1",
  realizations: {
    makeThumbnail: realizeDirect(() => {
      queuedDispatches.push("makeThumbnail");
      return { jobId: "job-1" };
    }, "makeThumbnail:queued-1"),
  },
});
const mismatch = bindProjection(thumbnailSurface, queuedInstallation, {
  admit: admitScreenOrScript,
});
// mismatch.status === "unrealized": a job ID does not satisfy ImageInfo.
// Binding checks declarations without dispatching thumbnail work.
```

```text
caller expects                     installation offers
{ imageId, width, height }    ✗    { jobId }
                              │
                           unrealized
                      zero handler dispatches
```

`mismatch.status` is `"unrealized"`, `mismatch.report.issues` pinpoints the exact incompatibility, and `queuedDispatches` stays empty—not a single handler ran.

Remember the limit too: a passing contract check cannot tell if your thumbnail looks blurry. Application tests and `@foxworth/boundary/testing` verify behavior. See [Guarantees and counterexamples](../concepts/guarantees.md).

## 8. Finally, add an AI agent

An agent needs to inspect images and generate thumbnails—never delete originals. Which interaction definitions need to change? **None.**

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

```text
application: [ inspectImage, makeThumbnail, deleteImage ]
agent:       [ inspectImage, makeThumbnail              ]
```

`deleteImage` does not exist on the agent's surface, and calling with `{ kind: "screen" }` fails admission before dispatch. To expose that exact Binding to an LLM as tools, connect it to the [MCP or WebMCP adapter](../reference/adapters.md).

---

**Next steps:**
- Want a shorter setup? See [Concise native authoring (`createHost`)](./concise-authoring.md).
- Ready to wire another caller or transport? See [Add another caller](./adding-a-caller.md).
- Need human approvals & crash recovery? See [Controlled effects](./controlled-effects.md).
- Integrating with Next, Hono, Vite, Electron, or Workers? See [Native application guides](../README.md#native-application-guides).
