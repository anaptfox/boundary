---
title: "Concise native authoring"
description: "Expose a small application scene to separate callers with one native TypeScript setup."
---

# Concise native authoring

Boundary's usual TypeScript lifecycle is explicit: define interactions, compile
them, install handlers, select a Projection for each caller, then bind each
Projection. `createHost` is a shorter native TypeScript entry for the
same direct-call path. It runs those lifecycle steps and returns their actual
artifacts alongside named methods.

This guide uses a small in-memory scene. Its state and functions belong to the
application. `move`, `capture`, and `render` are ordinary host handlers; the
declaration does not contain them.

```ts
import { z } from "zod";
import { createHost, defineInteraction } from "@foxworth/boundary";

type Actor = Readonly<{ role: "editor" | "assistant" }>;
const Position = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
  revision: z.number().int().nonnegative(),
});
const MoveInput = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
});
const CandidateRef = z.strictObject({ candidateId: z.string().min(1) });
const MissingCandidate = z.strictObject({ candidateId: z.string().min(1) });

const scene = {
  move: defineInteraction({
    id: "scene.move", input: MoveInput, output: Position,
    reads: ["scene.working"], changes: ["scene.working"],
  }),
  capture: defineInteraction({
    id: "scene.capture", output: CandidateRef,
    reads: ["scene.working"], changes: ["scene.candidates"],
  }),
  render: defineInteraction({
    id: "scene.render", input: CandidateRef, output: z.string(),
    errors: { missingCandidate: MissingCandidate },
    reads: ["scene.candidates"], changes: [],
  }),
} as const;
```

The schema types flow into the handler map and each named caller method. A
zero-input interaction such as `capture` takes only its actor; `move` and
`render` take input followed by actor.

```ts
const api = createHost(scene, {
  installationId: "scene:local:v1",
  realizationVersion: "scene-handlers:v1",
  handlers: {
    move(input, _actor: Actor) { return application.move(input, _actor); },
    capture(_actor: Actor) { return application.capture(_actor); },
    render(reference, _actor: Actor) { return application.render(reference, _actor); },
  },
  callers: {
    editor: {
      direct: ["move", "capture", "render"],
      admit: (actor) => actor.role === "editor",
    },
    assistant: {
      direct: ["capture", "render"],
      admit: (actor) => actor.role === "assistant",
    },
  },
});
```

`application` above represents the host's own functions and state. The
executable [scene fixture](../../examples/snippets/typescript/scene-authoring.ts)
uses plain in-memory `Map` values. Capture validates and freezes a position in
host-owned candidate storage, then returns only its ID. Render resolves that
ID against the candidate map and returns a declared `missingCandidate` error if
it is gone. It adds no collaboration or persistence dependency.

Each method still passes through its caller's native Binding and admission
rule. The actor is supplied on every call. The assistant has no `move` method:

<!-- snippet:examples/snippets/typescript/scene-authoring.ts#call-sequence -->
```ts
export async function runSceneAuthoringSequence() {
  const scene = await createSceneAuthoringExample();
  await scene.callers.editor.move({ id: "orb", x: 18, y: 24 }, scene.actors.editor);
  const captured = await scene.callers.assistant.capture(scene.actors.assistant);
  await scene.callers.editor.move({ id: "orb", x: 71, y: 83 }, scene.actors.editor);
  return scene.callers.assistant.render(captured, scene.actors.assistant);
}
```

The SVG uses the captured coordinates, `18,24`, after the live scene has moved
to `71,83`. The frozen candidate and its ID live only in the host's in-memory
map. Its revision and coordinates are application data, not a durable receipt
or CRDT history.

The result also exposes the compiled Program, Installation, Projections,
Bindings, and host-held controllers. Use those native artifacts for inspection
and lifecycle management; the named methods are a convenience over the same
checked callers. `bindingControllers.assistant.revoke()` revokes that exact
caller binding, and `installationController.revoke()` revokes the shared
installation. Existing projections and bindings remain independently
inspectable artifacts; revocation controls live execution.

The host chooses `installationId` and supplies `realizationVersion`; Boundary
does not derive the version from function source. Change that version when the
executable behavior changes. Caller-specific setup failures are collected in
`CreateHostError.issues`, each tagged with the caller name. Such a setup
failure exposes no usable caller and revokes bindings and the installation it
created. Invalid global definitions or handlers can fail earlier with their
own construction errors.

This convenience is TypeScript-only direct-call authoring. It does not change
portable contracts or add a Rust law; applications that need request mode,
independent persisted projections, or lower-level lifecycle control continue
to use the existing functions. Boundary also provides experimental read-only
Yjs and Automerge snapshot subpaths. They supply isolated projections of captured
document versions; the host still owns synchronization, persistence, candidate
IDs and storage, and policy. See [CRDT snapshots](./crdt-snapshots.md) for the
current scope and executable replica examples.
