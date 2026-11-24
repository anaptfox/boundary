import { createHost, defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

type Actor = { readonly id: string; readonly role: "human" | "assistant" };
const PointInput = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object", properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"], additionalProperties: false,
});
const PointOutput = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object", properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"], additionalProperties: false,
});
const StringOutput = portableSchema<string>({ type: "string" });
const definitions = {
  move: defineInteraction({ id: "types.move", input: PointInput, output: PointOutput }),
  capture: defineInteraction({ id: "types.capture", output: StringOutput }),
} as const;

const source = createHost(definitions, {
  installationId: "types:1",
  realizationVersion: "types-1",
  handlers: {
    move(input, actor: Actor) {
      input.x satisfies number;
      input.y satisfies number;
      // @ts-expect-error inputs come from this action's declared schema
      input.missing;
      actor.id satisfies string;
      actor.role satisfies "human" | "assistant";
      return { x: input.x, y: input.y } satisfies { readonly x: number; readonly y: number };
    },
    capture(actor: Actor) {
      actor.id satisfies string;
      return actor.id satisfies string;
    },
  },
  callers: {
    editor: { direct: ["move", "capture"], admit: actor => actor.role === "human" },
    assistant: { direct: ["capture"], admit: actor => actor.role === "assistant" },
  },
});

const callerSelection = {
  editor: { direct: ["move", "capture"], admit: (actor: Actor) => actor.role === "human" },
  assistant: { direct: ["capture"], admit: (actor: Actor) => actor.role === "assistant" },
} as const;

async function callerTypes() {
  const result = await source;
  result.callers.editor.move({ x: 1, y: 2 }, { id: "fox", role: "human" });
  const captured: string = await result.callers.editor.capture({ id: "fox", role: "human" });
  // @ts-expect-error output type is inferred from the declared output schema
  const wronglyTyped: number = captured;
  result.callers.assistant.capture({ id: "agent", role: "assistant" });
  // @ts-expect-error unknown caller names are absent from the result record
  result.callers.unknown;
  // @ts-expect-error unknown action names cannot be selected
  result.callers.editor.erase;
  // @ts-expect-error one-input action requires its input
  result.callers.editor.move({ id: "fox", role: "human" });
  // @ts-expect-error move requires numeric x and y inputs
  result.callers.editor.move({ x: "1", y: 2 }, { id: "fox", role: "human" });
  // @ts-expect-error caller methods require the configured actor
  result.callers.editor.capture();
  // @ts-expect-error wrong actor shape is rejected
  result.callers.editor.capture({ id: "fox", role: "robot" });
  // @ts-expect-error assistant selection omits move
  result.callers.assistant.move({ x: 1, y: 2 }, { id: "agent", role: "assistant" });
}

void callerTypes;

// One realization set has one host context type across all handlers.
createHost(definitions, {
  installationId: "types:incompatible-contexts",
  realizationVersion: "incompatible-contexts-1",
  handlers: {
    // @ts-expect-error handler actor context must match the inferred shared context
    move(input, actor: { readonly id: string }) { return input; },
    // @ts-expect-error handler actor context must match the inferred shared context
    capture(actor: { readonly team: string }) { return actor.team; },
  },
  // @ts-expect-error admission uses the one shared context for every action
  callers: { editor: { direct: ["move", "capture"], admit: (_actor: { readonly id: string }) => true } },
});

createHost(definitions, {
  installationId: "types:bad-handler-output",
  realizationVersion: "types-bad-1",
  handlers: {
    // @ts-expect-error handler result must match the declared output
    move: () => "wrong",
    capture: (actor: Actor) => actor.id,
  },
  callers: callerSelection,
});

createHost(definitions, {
  installationId: "types:missing-handler",
  realizationVersion: "types-missing-1",
  // @ts-expect-error handler coverage is exhaustive
  handlers: { capture: (actor: Actor) => actor.id },
  callers: callerSelection,
});

createHost(definitions, {
  installationId: "types:unknown-alias",
  realizationVersion: "types-unknown-1",
  handlers: {
    move: (input, actor: Actor) => input,
    capture: (actor: Actor) => actor.id,
  },
  // @ts-expect-error unknown action names cannot be selected
  callers: { editor: { direct: ["move", "erase"], admit: (_actor: Actor) => true } },
});

const extraHandlers = {
  move: (input: { readonly x: number; readonly y: number }) => input,
  capture: (actor: Actor) => actor.id,
  erase: () => "wrong",
};
createHost(definitions, {
  installationId: "types:extra-handler",
  realizationVersion: "types-extra-1",
  // @ts-expect-error handlers reject unknown action names, including variables
  handlers: extraHandlers,
  callers: callerSelection,
});

// In contextless mode a zero-input action takes no arguments; a one-input
// action still takes its declared input.
const contextless = createHost(definitions, {
  installationId: "types:contextless",
  realizationVersion: "contextless-1",
  handlers: {
    move(input) { return input; },
    capture() { return "captured"; },
  },
  callers: { screen: { direct: ["move", "capture"], admit: () => true } },
});

async function contextlessMethods() {
  const result = await contextless;
  result.callers.screen.capture();
  result.callers.screen.move({ x: 1, y: 2 });
  // @ts-expect-error contextless zero-input actions take no actor argument
  result.callers.screen.capture({});
  // @ts-expect-error zero-input action does not accept an empty object input
  result.callers.screen.capture({ x: 1, y: 2 });
}

void contextlessMethods;

// A one-input handler can also receive its actor in the second position.
createHost(definitions, {
  installationId: "types:input-and-context",
  realizationVersion: "input-context-1",
  handlers: {
    move(input, actor: Actor) { actor.id satisfies string; return input; },
    capture(actor: Actor) { return actor.id; },
  },
  callers: callerSelection,
});
