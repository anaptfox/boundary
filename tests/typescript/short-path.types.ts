import { admitWhen, defineInteraction, install, surface, type Caller } from "@foxworth/boundary";
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
  erase: defineInteraction({ id: "types.erase", input: PointInput, output: StringOutput }),
} as const;
const otherDefinitions = {
  move: defineInteraction({ id: "other.move", input: PointInput, output: StringOutput }),
} as const;

// A surface selects by alias; nothing is selected by default.
const editorSurface = surface(definitions, { call: ["move", "capture"], propose: ["erase"] });
const emptySurface = surface(definitions, {});
// @ts-expect-error a selection record is required; "all" must be spelled out
surface(definitions);
// @ts-expect-error unknown aliases cannot be selected
surface(definitions, { call: ["move", "delete"] });
// @ts-expect-error extra selection keys are rejected
surface(definitions, { call: ["move"], direct: ["capture"] });
const everything = surface.all(definitions);

const installed = install(definitions, {
  id: "types:1",
  version: "types-1",
  handlers: {
    move(input, actor: Actor) {
      input.x satisfies number;
      // @ts-expect-error inputs come from this action's declared schema
      input.missing;
      actor.role satisfies "human" | "assistant";
      return { x: input.x, y: input.y } satisfies { readonly x: number; readonly y: number };
    },
    capture(actor: Actor) {
      return actor.id satisfies string;
    },
    erase(input, actor: Actor) {
      return `${input.x}:${actor.id}`;
    },
  },
});

async function callerTypes() {
  const app = await installed;
  const editor = await app.connect(editorSurface, { admit: admitWhen((actor: Actor) => actor.role === "human") });
  editor.move({ x: 1, y: 2 }, { id: "fox", role: "human" });
  const captured: string = await editor.capture({ id: "fox", role: "human" });
  // @ts-expect-error output type is inferred from the declared output schema
  const wronglyTyped: number = captured;
  // @ts-expect-error a proposal cannot be used as a call
  editor.erase({ x: 1, y: 2 }, { id: "fox", role: "human" });
  await editor.propose.erase({ x: 1, y: 2 }, { id: "fox", role: "human" });
  // @ts-expect-error a call-only alias has no propose method
  editor.propose.move;
  // @ts-expect-error unselected aliases are absent
  editor.unknown;
  // @ts-expect-error one-input action requires its input
  editor.move({ id: "fox", role: "human" });
  // @ts-expect-error move requires numeric x and y inputs
  editor.move({ x: "1", y: 2 }, { id: "fox", role: "human" });
  // @ts-expect-error caller methods require the configured actor
  editor.capture();
  // @ts-expect-error wrong actor shape is rejected
  editor.capture({ id: "fox", role: "robot" });
  // @ts-expect-error the caller carries no controller
  editor.revoke;
  editor.manifest.bindingDigest satisfies string;
  editor.handoff.manifest satisfies typeof editor.manifest;

  // "All" is never implicit: an empty surface has no methods.
  const nothing = await app.connect(emptySurface, { admit: admitWhen((_actor: Actor) => true) });
  // @ts-expect-error nothing was selected
  nothing.move;
  const all = await app.connect(everything, { admit: admitWhen((_actor: Actor) => true) });
  all.erase({ x: 1, y: 2 }, { id: "fox", role: "human" });

  // admit is required on every connect; there is no admit-all default.
  // @ts-expect-error admit is required
  await app.connect(editorSurface, {});
  // @ts-expect-error admit must be an admission function
  await app.connect(editorSurface, { admit: true });

  // A surface over another declaration record does not connect.
  const foreign = surface(otherDefinitions, { call: ["move"] });
  // @ts-expect-error the surface was built from a different declaration record
  await app.connect(foreign, { admit: admitWhen((_actor: Actor) => true) });

  // The caller type is nominal over its aliases, not over the installation.
  const typed: Caller<typeof definitions, "move" | "capture", "erase", Actor> = editor;
  void typed;
  void wronglyTyped;
}

void callerTypes;

// Handlers are exhaustive and typed from the declarations.
install(definitions, {
  version: "types-missing-1",
  // @ts-expect-error handler coverage is exhaustive
  handlers: { capture: (actor: Actor) => actor.id },
});

install(definitions, {
  version: "types-bad-1",
  // @ts-expect-error handler result must match the declared output
  handlers: {
    move: () => "wrong",
    capture: (actor: Actor) => actor.id,
    erase: () => "",
  },
});

// One Installation has one host context type across all handlers.
install(definitions, {
  version: "incompatible-contexts-1",
  // @ts-expect-error handler actor contexts must agree on one shared context
  handlers: {
    move(input, actor: { readonly id: string }) { return input; },
    capture(actor: { readonly team: string }) { return actor.team; },
    erase: () => "",
  },
});

// Exactly one of handlers or dispatch.
// @ts-expect-error an installation needs handlers or dispatch
install(definitions, { version: "neither-1" });

// In contextless mode a zero-input action takes no arguments.
const contextless = install(definitions, {
  version: "contextless-1",
  handlers: {
    move(input) { return input; },
    capture() { return "captured"; },
    erase() { return ""; },
  },
});

async function contextlessMethods() {
  const app = await contextless;
  const screen = await app.connect(surface(definitions, { call: ["move", "capture"] }), { admit: admitWhen(() => true) });
  screen.capture();
  screen.move({ x: 1, y: 2 });
  // @ts-expect-error contextless zero-input actions take no actor argument
  screen.capture({});
}

void contextlessMethods;
