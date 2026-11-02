---
title: "Build a thumbnail plugin"
description: "Realize a declared interaction in a component and refuse imports the host did not provide."
---

# Build a thumbnail plugin

An application can keep its image store and policy in TypeScript while a
plugin author uses Zig or another component toolchain to implement thumbnail
calculation. The host declares `images.makeThumbnail`; the plugin receives only
source dimensions through the `images` footprint and returns resized dimensions.
The host keeps image bytes, credentials, admission, and interaction meaning.

## Declare the interaction

Use the ordinary handler-free declaration:

```ts
import { z } from "zod";
import { compileInteractions, defineInteraction } from "@foxworth/boundary";

const makeThumbnail = defineInteraction({
  id: "images.makeThumbnail",
  input: z.strictObject({ imageId: z.string(), maxWidth: z.number().int().positive() }),
  output: z.strictObject({
    imageId: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
  }),
  reads: ["images"],
  changes: ["images"],
});
const compiled = await compileInteractions({ makeThumbnail });
```

`compiled.program` contains the contract and its identity. It contains no
handler, image store, caller context, or authority.

## Project the WIT world

Project that Program into the `boundary:guest` world. The interaction export is derived
as `images-make-thumbnail`:

```ts
import { projectWit } from "@foxworth/boundary/plugin";

const projection = projectWit(compiled.program);
const exportName = projection.interactions[0].witName;
// Persist projection.wit and give those exact bytes to the plugin author.
```

Build the [checked-in Zig implementation](../../examples/guests/thumbnail/zig/README.md)
from the repository root:

```sh
just wasm-zig-guest
```

The generated component at
`examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm` is the
concrete plugin artifact. It imports
`boundary:guest/footprints@1.0.0#images`, exports `images-make-thumbnail`, asks for
`{ imageId, maxWidth }`, and calculates an aspect-ratio-preserving result.

## Inspect and load it in TypeScript

The host hashes the exact WIT source it persisted, provides only the `images`
footprint, and inspects the component's actual imports:

```ts
import { createHash } from "node:crypto";
import {
  HostImports,
  createPluginExecutor,
  inspectPlugin,
  loadPlugin,
} from "@foxworth/boundary/plugin";

const witDigest = `sha256:${createHash("sha256").update(projection.wit).digest("hex")}`;
const imports = new HostImports("boundary:guest/footprints@1.0.0").provide("images");
const inspection = await inspectPlugin(componentBytes, imports, witDigest);
const executor = createPluginExecutor();
if (inspection.check.status === "refused") {
  throw new Error(`unmapped imports: ${inspection.check.unmapped.join(", ")}`);
}

const loaded = await loadPlugin({
  bytes: componentBytes,
  imports,
  witDigest,
  host: {
    async images(request, { signal }) {
      if (signal.aborted) return { tag: "unknown", val: "aborted" };
      const { imageId } = JSON.parse(request) as { imageId: string };
      const dimensions = imageId === "original"
        ? { width: 800, height: 600 }
        : imageId === "tiny"
          ? { width: 50, height: 20 }
          : undefined;
      return dimensions === undefined
        ? { tag: "err", val: JSON.stringify({ error: "not_found" }) }
        : JSON.stringify(dimensions);
    },
  },
  executor,
});
if (loaded.status === "refused") {
  throw new Error(`unmapped imports: ${loaded.unmapped.join(", ")}`);
}
if (loaded.status === "fault") throw new Error(loaded.reason);
```

`componentBytes` is the component artifact supplied by the plugin author. The
host function above exposes dimensions only; it does not pass image bytes or a
caller context into the component. A clock, filesystem, or second interface is
also refused unless the host deliberately provides it. A provided import also
must have exactly the signature `string -> result<string, string>`; a component
declaring any other signature is refused before any of its code, including start
functions, runs.

The component author consumes the generated WIT source with their language's
component toolchain. The WIT world describes the interaction boundary; it does
not grant the plugin access to the host.

## Call the component export

The loaded instance exposes the derived export. A direct plugin call returns
the component's JSON payload; composing it behind an Boundary Binding is what
validates the interaction's input and output schemas and preserves lifecycle
certainty:

```ts
const call = await loaded.instance.call(
  exportName,
  JSON.stringify({ imageId: "original", maxWidth: 200 }),
);
if (call.status !== "returned") throw new Error("thumbnail plugin failed");
const thumbnail = JSON.parse(call.payload) as {
  imageId: string; width: number; height: number;
};
// The Zig component calculates 800x600 at maxWidth 200 as 200x150.
if (thumbnail.width !== 200 || thumbnail.height !== 150) {
  throw new Error("unexpected thumbnail dimensions");
}
```

## Bind it as the host interaction

Install the component behind the declared interaction using the realization id
returned by the loader. The application supplies the dispatcher that translates
plugin replies into native host outcomes:

```ts
import { bindSurface, installInteractions, projectInteractions } from "@foxworth/boundary";

const { installation } = await installInteractions(compiled, {
  installationId: "images:plugin:thumbnail:1",
  realizationIds: {
    makeThumbnail: { direct: loaded.inspection.realizationId },
  },
  bindings: [{
    interaction: compiled.handles.makeThumbnail,
    target: loaded.instance,
    async dispatch({ input, outcomes }) {
      const reply = await loaded.instance.call(exportName, JSON.stringify(input));
      if (reply.status === "returned") {
        return outcomes.returned(JSON.parse(reply.payload));
      }
      if (reply.status === "fault") {
        if (reply.certainty === "not-started") return outcomes.notStarted();
        if (reply.certainty === "not-completed") return outcomes.notCompleted();
      }
      // This declaration has no domain errors. An unexpected error or an
      // uncertain execution cannot become a successful thumbnail.
      return outcomes.unknown();
    },
  }],
});
const callerProjection = await projectInteractions(compiled, {
  makeThumbnail: { interaction: compiled.handles.makeThumbnail, modes: ["direct"] },
});
const bound = await bindSurface(callerProjection, installation, {
  admit: () => ({ decision: "allow" }), // the application's admission policy
});
if (bound.status !== "bound") throw new Error("thumbnail interaction did not bind");
const handle = bound.binding.resolve("images.makeThumbnail");
if (handle === undefined) throw new Error("thumbnail interaction is unavailable");
const outcome = await bound.binding.connect().callRaw(handle, {
  imageId: "original", maxWidth: 200,
});
```

When the host revokes this binding, close the instance and then the executor:

```ts
await loaded.instance.close();
await executor.close();
```

The [TypeScript Binding proof](../../tests/typescript/plugin-binding.test.ts)
exercises this composition, checks the `200 × 150` result, and verifies that
an uncertain host reply stays uncertain without an automatic retry.

## Preserve uncertain outcomes

`PluginHostFunction` can return a JSON string, `{ tag: "ok" | "err", val }`, or
`{ tag: "unknown", val }`. `err` is a declared domain error. `unknown` traps
the component instead of crossing the WIT `result<string, string>` wire, so a
plugin cannot turn an effect that may have started into definite success.

The default `PluginLifetime` is `per-call`, which gives every call fresh guest
state. `persistent` can retain guest heap state and therefore has a different
realization identity. Node's jco path applies the import law but does not
provide Rust wasmtime fuel, memory, table, or instance limits. Its executor
uses bounded artifact preparation and worker counts, serializes calls for one
artifact, and exposes queue and call deadlines. A queued timeout is
`not-started`; a dispatched timeout is `unknown` and terminates the worker,
invalidating bindings for that artifact. Host callback abort is advisory and
there is no automatic retry. Use the Rust host when fuel and linear-memory
limits are part of the acceptance boundary.
