---
title: "Concise native authoring"
description: "Wire a complete application with multiple checked callers in one synchronous TypeScript call using createHost."
---

# Concise native authoring

When your interactions, handlers, and direct callers all live in one TypeScript process, you don't need to assemble `compileInteractions`, `projectInteractions`, `installInteractions`, and `bindProjection` by hand.

`createHost` runs that exact lifecycle **synchronously** in one call—returning ergonomic named methods (`callers.*` and typed-outcome `tryCallers.*`) alongside every real underlying artifact (`compiled`, `installation`, `projections`, `bindings`, and host-held revocation controllers).

## 1. Declare the scene's interactions

This in-memory scene lets an editor move an orb, and lets both the editor and an assistant capture a frozen candidate and render it to SVG. You can use either zero-dependency `b.object(...)` or Zod (`z.strictObject(...)`)—the example below uses Zod to show it works out of the box:

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

Schema types flow automatically into both `handlers` and every caller method. Notice zero-input interactions like `capture` take only the actor—no dummy `{}` argument.

## 2. Wire handlers and callers in one synchronous call

```ts
const api = createHost(scene, {
  installationId: "scene:local:v1",
  realizationVersion: "scene-handlers:v1",
  handlers: {
    move(input, actor: Actor) { return application.move(input, actor); },
    capture(actor: Actor) { return application.capture(actor); },
    render(reference, actor: Actor) { return application.render(reference, actor); },
  },
  callers: {
    editor: {
      direct: ["move", "capture", "render"],
      admit: (actor) => actor.role === "editor",
    },
    assistant: {
      direct: ["capture", "render"], // `move` is absent at compile time and runtime
      admit: (actor) => actor.role === "assistant",
    },
  },
});
```

`application` is your own ordinary code and state (see the executable [scene fixture](../../examples/snippets/typescript/scene-authoring.ts)).

## 3. Call with throwing methods or exhaustive typed outcomes

Every method passes through its caller's checked Binding and admission rule. The assistant has no `move` method:

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

Prefer handling declared errors, denials, and faults without `try/catch`? Use `api.tryCallers`:

```ts
const outcome = await api.tryCallers.assistant.render(captured, assistantActor);
switch (outcome.kind) {
  case "ok": return outcome.value;
  case "declared-error": return `Missing: ${outcome.code}`; // exhaustive on declared errors
  case "denied": return "Not allowed";
  case "fault": return `Fault (${outcome.certainty})`;
}
```

## 4. Keep full lifecycle control

`createHost` is not a black box—it exposes every real artifact:
- `api.compiled`, `api.installation`, `api.projections`, `api.bindings` for inspection, adapters (HTTP, MCP, React), and Plan preflight.
- `api.bindingControllers.assistant.revoke()` to revoke one caller surface immediately.
- `api.installationController.revoke()` to revoke the shared installation across all callers.
- Setup is atomic: if any caller fails to bind, `CreateHostError` collects all tagged issues in `.issues` and revokes everything it created so no half-wired host escapes.

Bump `realizationVersion` whenever handler behavior changes; Boundary never hashes function source.

## When to step down to the explicit lifecycle

`createHost` is a TypeScript convenience for in-process direct callers. Drop down to `compileInteractions` + `installInteractions` + `bindProjection` when you need:
- `request` mode ([Controlled effects](./controlled-effects.md));
- independent Projections persisted or shared across processes/Rust;
- live hot-rebinding via `createBindingSlot`;
- `bindAuthorizedProjection` to narrow auth context into handlers and observed reads.

For experimental read-only Yjs and Automerge snapshot projections, see [CRDT snapshots](./crdt-snapshots.md).
