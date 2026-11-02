import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Prove the root short path (surface, install, connect) from a temporary installed-package consumer. */
export function proveShortPathConsumer(consumerRoot) {
  const runtime = path.join(consumerRoot, "short-path-consumer.mjs");
  writeFileSync(runtime, `
import assert from "node:assert/strict";
import { admitWhen, install, surface, ConnectError } from "@foxworth/boundary";
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
const app = await install(definitions, {
  id: "consumer:canvas:1",
  version: "consumer-build-1",
  handlers: {
    move(input) { position = input; return position; },
    capture() { return JSON.stringify(position); },
    render() { return "frame:" + JSON.stringify(position); },
  },
});
const editor = await app.connect(surface.all(definitions), {
  admit: admitWhen((actor) => actor.role === "human", "human only"),
});
const assistant = await app.connect(surface(definitions, { call: ["capture"] }), {
  admit: admitWhen((actor) => actor.role === "assistant", "assistant only"),
});
const human = { id: "fox", role: "human" };
const agent = { id: "agent", role: "assistant" };
assert.deepEqual(Object.keys(editor).sort(), ["capture", "move", "render"]);
assert.deepEqual(Object.keys(assistant), ["capture"]);
assert.equal(assistant.move, undefined);
assert.deepEqual(await editor.move({ x: 7, y: 11 }, human), { x: 7, y: 11 });
assert.equal(await assistant.capture(agent), "{\\"x\\":7,\\"y\\":11}");
assert.equal(await editor.render(human), "frame:{\\"x\\":7,\\"y\\":11}");
assert.equal(editor.manifest.interactions.length, 3);
assert.equal(app.binding(editor).manifest, editor.manifest);
assert.equal("revoke" in editor, false);
const generated = await install(definitions, { version: "consumer-build-1", handlers: {
  move(input) { return input; }, capture() { return ""; }, render() { return ""; },
} });
assert.match(generated.id, /^generated:/);
await assert.rejects(
  generated.connect(surface(definitions, { propose: ["move"] }), { admit: admitWhen(() => true) }),
  (error) => error instanceof ConnectError && error.report.issues[0].reason === "missing-request" && error.fix.length > 0,
);
assert.equal(app.revoke(editor), true);
await assert.rejects(editor.capture(human), error => error.cause === "revoked" && error.certainty === "not-started");
assert.equal(await assistant.capture(agent), "{\\"x\\":7,\\"y\\":11}");
assert.equal(app.revoke(), true);
await assert.rejects(assistant.capture(agent), error => error.cause === "revoked" && error.certainty === "not-started");
console.log("Packed short path composes and narrows native bindings.");
`.replace('import { admitWhen, install, surface, ConnectError } from "@foxworth/boundary";', 'import { admitWhen, defineInteraction, install, surface, ConnectError } from "@foxworth/boundary";'));
  execFileSync(process.execPath, [runtime], { cwd: consumerRoot, stdio: "inherit", timeout: 30_000 });

  const types = path.join(consumerRoot, "short-path-consumer.types.ts");
  writeFileSync(types, `
import { admitWhen, defineInteraction, install, surface } from "@foxworth/boundary";
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
} as const;
async function checkTypes() {
  const app = await install(definitions, {
    id: "consumer:types:1", version: "types-1",
    handlers: {
      move(input, actor: Actor) { actor.id satisfies string; return { x: input.x, y: input.y }; },
      capture(actor: Actor) { return actor.id; },
    },
  });
  const editor = await app.connect(surface(definitions, { call: ["move", "capture"] }), {
    admit: admitWhen((_actor: Actor) => true),
  });
  editor.move({ x: 1, y: 2 }, { id: "fox", role: "human" });
  editor.capture({ id: "fox", role: "human" });
  // @ts-expect-error unknown methods are not exposed
  editor.delete;
  // @ts-expect-error declared input is required
  editor.move({ id: "fox", role: "human" });
  // @ts-expect-error actor is required
  editor.capture();
  // @ts-expect-error actor shape is checked
  editor.capture({ id: "fox", role: "robot" });
  // @ts-expect-error the caller carries no controller
  editor.revoke;
  // @ts-expect-error admit is required on every connect
  await app.connect(surface(definitions, { call: ["capture"] }), {});
}
void checkTypes;
`);
  execFileSync(process.execPath, [
    path.join(consumerRoot, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", types,
  ], { cwd: consumerRoot, stdio: "inherit", timeout: 30_000 });
}
