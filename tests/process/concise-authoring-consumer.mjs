import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Prove the root concise-authoring API from a temporary installed-package consumer. */
export function proveConciseAuthoringConsumer(consumerRoot) {
  const runtime = path.join(consumerRoot, "concise-authoring-consumer.mjs");
  writeFileSync(runtime, `
import assert from "node:assert/strict";
import { bindInteractions, defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Point = portableSchema({
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
});
const Text = portableSchema({ type: "string" });
const definitions = {
  move: defineInteraction({ id: "consumer.move", input: Point, output: Point, changes: ["canvas"] }),
  capture: defineInteraction({ id: "consumer.capture", output: Text, reads: ["canvas"] }),
  render: defineInteraction({ id: "consumer.render", output: Text, reads: ["canvas"] }),
};
let position = { x: 0, y: 0 };
const result = bindInteractions(definitions, {
  installationId: "consumer:canvas:1",
  realizationVersion: "consumer-build-1",
  handlers: {
    move(input) { position = input; return position; },
    capture() { return JSON.stringify(position); },
    render() { return "frame:" + JSON.stringify(position); },
  },
  callers: {
    editor: { direct: ["move", "capture", "render"], admit: actor => actor.role === "human" },
    assistant: { direct: ["capture"], admit: actor => actor.role === "assistant" },
  },
});
const human = { id: "fox", role: "human" };
const assistant = { id: "agent", role: "assistant" };
assert.deepEqual(Object.keys(result.callers.editor).sort(), ["capture", "move", "render"]);
assert.deepEqual(Object.keys(result.callers.assistant), ["capture"]);
assert.deepEqual(await result.callers.editor.move({ x: 7, y: 11 }, human), { x: 7, y: 11 });
assert.equal(await result.callers.assistant.capture(assistant), "{\\"x\\":7,\\"y\\":11}");
assert.equal(await result.callers.editor.render(human), "frame:{\\"x\\":7,\\"y\\":11}");
assert.equal(result.bindings.editor.manifest.interactions.length, 3);
result.bindingControllers.editor.revoke();
await assert.rejects(result.callers.editor.capture(human), error => error.cause === "revoked" && error.certainty === "not-started");
assert.equal(await result.callers.assistant.capture(assistant), "{\\"x\\":7,\\"y\\":11}");
result.installationController.revoke();
await assert.rejects(result.callers.assistant.capture(assistant), error => error.cause === "revoked" && error.certainty === "not-started");
console.log("Packed concise authoring composes and narrows native bindings.");
`);
  execFileSync(process.execPath, [runtime], { cwd: consumerRoot, stdio: "inherit", timeout: 30_000 });

  const types = path.join(consumerRoot, "concise-authoring-consumer.types.ts");
  writeFileSync(types, `
import { bindInteractions, defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
type Actor = { readonly id: string; readonly role: "human" | "assistant" };
const Point = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object", properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"], additionalProperties: false,
});
const Text = portableSchema<string>({ type: "string" });
const definitions = {
  move: defineInteraction({ id: "consumer.types.move", input: Point, output: Point }),
  capture: defineInteraction({ id: "consumer.types.capture", output: Text }),
};
const result = bindInteractions(definitions, {
  installationId: "consumer:types:1", realizationVersion: "types-1",
  handlers: {
    move(input, actor: Actor) { actor.id satisfies string; return { x: input.x, y: input.y }; },
    capture(actor: Actor) { return actor.id; },
  },
  callers: {
    editor: { direct: ["move", "capture"], admit: _actor => true },
  },
});
async function checkTypes() {
  const bound = await result;
  bound.callers.editor.move({ x: 1, y: 2 }, { id: "fox", role: "human" });
  bound.callers.editor.capture({ id: "fox", role: "human" });
  // @ts-expect-error unknown methods are not exposed
  bound.callers.editor.delete;
  // @ts-expect-error declared input is required
  bound.callers.editor.move({ id: "fox", role: "human" });
  // @ts-expect-error actor is required
  bound.callers.editor.capture();
  // @ts-expect-error actor shape is checked
  bound.callers.editor.capture({ id: "fox", role: "robot" });
}
void checkTypes;
`);
  execFileSync(process.execPath, [
    path.join(consumerRoot, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", types,
  ], { cwd: consumerRoot, stdio: "inherit", timeout: 30_000 });
}
