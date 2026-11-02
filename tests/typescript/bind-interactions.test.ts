import { describe, expect, it } from "vitest";
import {
  BindInteractionsError,
  bindInteractions,
  bindProjection,
  compileInteractions,
  defineInteraction,
  declaredInteractionError,
  implementInteractions,
  isDeclaredInteractionError,
  installInteractions,
  projectInteractions,
  directRealizationIds,
} from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const MoveInput = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
});
const Text = portableSchema<string>({ type: "string" });
const Position = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
});
type Actor = { readonly id: string; readonly role: "human" | "assistant" };

const definitions = {
  move: defineInteraction({ id: "canvas.move", input: MoveInput, output: Position, changes: ["canvas"] }),
  capture: defineInteraction({ id: "canvas.capture", output: Text, reads: ["canvas"] }),
  render: defineInteraction({ id: "canvas.render", output: Text, reads: ["canvas"] }),
} as const;

const keys = (record: object) => Object.keys(record).sort();

describe("bindInteractions", () => {
  it("composes the native pipeline and lets a human read the live state after a mutation", async () => {
    let position = { x: 2, y: 4 };
    const seenActors: string[] = [];
    const result = await bindInteractions(definitions, {
      installationId: "canvas:local:1",
      realizationVersion: "build-7",
      handlers: {
        move(input, actor: Actor) {
          seenActors.push(actor.id);
          position = { x: input.x, y: input.y };
          return position;
        },
        capture(actor: Actor) { seenActors.push(actor.id); return `${position.x},${position.y}`; },
        render(actor: Actor) { seenActors.push(actor.id); return `render:${position.x},${position.y}`; },
      },
      callers: {
        editor: { direct: ["move", "capture", "render"], admit: actor => actor.role === "human" },
        assistant: { direct: ["capture", "render"], admit: actor => actor.role === "assistant" },
      },
    });

    const human: Actor = { id: "fox", role: "human" };
    const assistant: Actor = { id: "agent-1", role: "assistant" };
    await expect(result.callers.editor.move({ x: 8, y: 13 }, human)).resolves.toEqual({ x: 8, y: 13 });
    await expect(result.callers.editor.capture(human)).resolves.toBe("8,13");
    await expect(result.callers.assistant.render(assistant)).resolves.toBe("render:8,13");
    expect(seenActors).toEqual(["fox", "fox", "agent-1"]);

    expect(result.compiled.handles.move.interactionId).toBe("canvas.move");
    expect(result.installation.manifest.installationId).toBe("canvas:local:1");
    expect(result.bindings.editor.manifest.interactions.map(item => item.alias)).toEqual(["capture", "move", "render"]);
    expect(result.bindings.assistant.manifest.interactions.map(item => item.alias)).toEqual(["capture", "render"]);
  });

  it("preserves zero-input, one-input, and contextless handler conventions", async () => {
    const result = await bindInteractions(definitions, {
      installationId: "canvas:arity:1",
      realizationVersion: "arity-1",
      handlers: {
        move: (input) => ({ x: input.x, y: input.y }),
        capture: () => "captured",
        render: () => "rendered",
      },
      callers: {
        screen: { direct: ["move", "capture", "render"], admit: () => true },
      },
    });
    await expect(result.callers.screen.move({ x: 1, y: 3 })).resolves.toEqual({ x: 1, y: 3 });
    await expect(result.callers.screen.capture()).resolves.toBe("captured");
    await expect(result.callers.screen.render()).resolves.toBe("rendered");
  });

  it("evaluates admission on every call with the current actor and does not dispatch a denied call", async () => {
    let allowed = true;
    let calls = 0;
    const result = await bindInteractions(definitions, {
      installationId: "canvas:admission:1",
      realizationVersion: "admission-1",
      handlers: {
        move(input, _actor: Actor) { calls += 1; return input; },
        capture() { calls += 1; return "captured"; },
        render() { calls += 1; return "rendered"; },
      },
      callers: { editor: { direct: ["move"], admit: actor => allowed && actor.id === "fox" } },
    });
    const actor: Actor = { id: "fox", role: "human" };
    await result.callers.editor.move({ x: 1, y: 2 }, actor);
    allowed = false;
    await expect(result.callers.editor.move({ x: 3, y: 4 }, actor)).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    expect(calls).toBe(1);
  });

  it("awaits asynchronous admission and preserves rejected admission as not started", async () => {
    let decision: "allow" | "deny" | "reject" = "allow";
    let calls = 0;
    const result = await bindInteractions(definitions, {
      installationId: "canvas:async-admission:1",
      realizationVersion: "async-admission-1",
      handlers: {
        move(input, _actor: Actor) { calls += 1; return input; },
        capture() { calls += 1; return "captured"; },
        render() { calls += 1; return "rendered"; },
      },
      callers: {
        editor: {
          direct: ["move"],
          async admit(actor) {
            if (decision === "reject") throw new Error(`policy failed for ${actor.id}`);
            await Promise.resolve();
            return decision === "allow";
          },
        },
      },
    });
    const actor: Actor = { id: "fox", role: "human" };
    await expect(result.callers.editor.move({ x: 1, y: 2 }, actor)).resolves.toEqual({ x: 1, y: 2 });
    decision = "deny";
    await expect(result.callers.editor.move({ x: 3, y: 4 }, actor)).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    decision = "reject";
    await expect(result.callers.editor.move({ x: 5, y: 6 }, actor)).rejects.toMatchObject({ cause: "admission-failed", certainty: "not-started" });
    expect(calls).toBe(1);
  });

  it("keeps selected methods narrow while exposing an authentic native Binding", async () => {
    let moveCalls = 0;
    const result = await bindInteractions(definitions, {
      installationId: "canvas:narrow:1",
      realizationVersion: "narrow-1",
      handlers: {
        move: input => { moveCalls += 1; return input; },
        capture: () => "captured",
        render: () => "rendered",
      },
      callers: {
        editor: { direct: ["move"], admit: () => true },
        assistant: { direct: ["capture"], admit: () => true },
      },
    });
    expect(keys(result.callers.assistant)).toEqual(["capture"]);
    expect(result.bindings.assistant.manifest.interactions).toHaveLength(1);
    expect(result.bindings.assistant.resolve("canvas.move")).toBeUndefined();
    const native = result.bindings.assistant.connect();
    await expect(Reflect.apply(native.call, native, [result.projections.editor.handles.move, { x: 1, y: 2 }]))
      .rejects.toMatchObject({ cause: "invalid-invocation", certainty: "not-started" });
    expect(moveCalls).toBe(0);
    await expect(native.call(result.projections.assistant.handles.capture)).resolves.toBe("captured");
    expect(result.bindings.assistant.manifest.bindingDigest).toMatch(/^sha256:/u);
  });

  it("uses the original caller selection, admission predicate, and handler functions after invocation starts", async () => {
    const aliases: Array<"move" | "capture" | "render"> = ["move", "capture"];
    const handlers = {
      move(input: { readonly x: number; readonly y: number }, _actor: Actor) {
        return { x: input.x, y: input.y };
      },
      capture(_actor: Actor) { return "original capture"; },
      render(_actor: Actor) { return "original render"; },
    };
    const callers = {
      editor: {
        direct: aliases,
        admit: (actor: Actor) => actor.role === "human",
      },
    };
    const pending = bindInteractions(definitions, {
      installationId: "canvas:snapshot:1",
      realizationVersion: "snapshot-1",
      handlers,
      callers,
    });

    aliases.splice(0, aliases.length, "render");
    callers.editor.admit = () => false;
    handlers.move = (_input, _actor) => ({ x: -1, y: -1 });
    handlers.capture = () => "mutated capture";
    handlers.render = () => "mutated render";

    const result = await pending;
    expect(keys(result.callers.editor)).toEqual(["capture", "move"]);
    const human: Actor = { id: "fox", role: "human" };
    await expect(result.callers.editor.move({ x: 4, y: 9 }, human)).resolves.toEqual({ x: 4, y: 9 });
    await expect(result.callers.editor.capture(human)).resolves.toBe("original capture");
  });

  it("revokes both a caller binding and the shared installation", async () => {
    const result = await bindInteractions(definitions, {
      installationId: "canvas:revoke:1",
      realizationVersion: "revoke-1",
      handlers: {
        move: input => input,
        capture: () => "captured",
        render: () => "rendered",
      },
      callers: {
        editor: { direct: ["capture"], admit: () => true },
        assistant: { direct: ["render"], admit: () => true },
      },
    });
    expect(result.bindingControllers.editor.revoke()).toBe(true);
    await expect(result.callers.editor.capture()).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    await expect(result.callers.assistant.render()).resolves.toBe("rendered");
    expect(result.installationController.revoke()).toBe(true);
    await expect(result.callers.assistant.render()).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
  });

  it("preserves declared errors and unknown failures without retrying handlers", async () => {
    const Problem = portableSchema<{ readonly code: string }>({
      type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
    });
    const source = {
      fail: defineInteraction({ id: "canvas.fail", input: Text, output: Text, errors: { unavailable: Problem } }),
    } as const;
    const declared = declaredInteractionError(source.fail, "unavailable", { code: "locked" });
    const unknown = new Error("acknowledgement lost");
    let declaredCalls = 0;
    let unknownCalls = 0;
    const result = await bindInteractions(source, {
      installationId: "canvas:failure:1", realizationVersion: "failure-1",
      handlers: {
        fail(input) {
          if (input === "declared") { declaredCalls += 1; throw declared; }
          unknownCalls += 1;
          throw unknown;
        },
      },
      callers: { editor: { direct: ["fail"], admit: () => true } },
    });
    let caught: unknown;
    try { await result.callers.editor.fail("declared"); } catch (error) { caught = error; }
    expect(isDeclaredInteractionError(caught, result.projections.editor.handles.fail, "unavailable")).toBe(true);
    await expect(result.callers.editor.fail("unknown")).rejects.toMatchObject({ cause: "realization-failed", certainty: "unknown" });
    expect(declaredCalls).toBe(1);
    expect(unknownCalls).toBe(1);
  });

  it("matches an explicit compile, install, project, and bind pipeline", async () => {
    let revision = "before";
    const handlers = {
      move(input: { readonly x: number; readonly y: number }, _actor: Actor) { revision = `${input.x},${input.y}`; return { x: input.x, y: input.y }; },
      capture(_actor: Actor) { return revision; },
      render(_actor: Actor) { return `frame:${revision}`; },
    };
    const combined = await bindInteractions(definitions, {
      installationId: "canvas:equivalence:1", realizationVersion: "equivalence-1", handlers,
      callers: { editor: { direct: ["move", "capture", "render"], admit: () => true } },
    });

    let explicitRevision = "before";
    const explicitHandlers = {
      move(input: { readonly x: number; readonly y: number }, _actor: Actor) { explicitRevision = `${input.x},${input.y}`; return { x: input.x, y: input.y }; },
      capture(_actor: Actor) { return explicitRevision; },
      render(_actor: Actor) { return `frame:${explicitRevision}`; },
    };
    const compiled = await compileInteractions(definitions);
    const installed = await installInteractions(compiled, {
      installationId: "canvas:equivalence:1",
      realizationIds: directRealizationIds(compiled, "equivalence-1"),
      implementations: implementInteractions<typeof definitions, Actor>(definitions, explicitHandlers),
    });
    const projection = await projectInteractions(compiled, {
      move: { interaction: compiled.handles.move, modes: ["direct"] },
      capture: { interaction: compiled.handles.capture, modes: ["direct"] },
      render: { interaction: compiled.handles.render, modes: ["direct"] },
    });
    const bound = await bindProjection(projection, installed.installation, { admit: () => ({ decision: "allow" }) });
    if (bound.status !== "bound") throw new Error("explicit pipeline did not bind");

    const actor: Actor = { id: "human", role: "human" };
    await combined.callers.editor.move({ x: 5, y: 9 }, actor);
    await bound.binding.connect().call(projection.handles.move, { x: 5, y: 9 }, actor);
    await expect(combined.callers.editor.capture(actor)).resolves.toBe(await bound.binding.connect().call(projection.handles.capture, actor));
    await expect(combined.callers.editor.render(actor)).resolves.toBe(await bound.binding.connect().call(projection.handles.render, actor));
    expect(combined.bindings.editor.manifest).toEqual(bound.binding.manifest);
  });

  it("collects failures per caller without publishing partial maps", async () => {
    const withReservedAlias = {
      ...definitions,
      then: defineInteraction({ id: "canvas.then", output: Text }),
    } as const;
    let caught: unknown;
    try {
      await bindInteractions(withReservedAlias, {
      installationId: "canvas:aggregate:1", realizationVersion: "aggregate-1",
      handlers: { move: input => input, capture: () => "captured", render: () => "rendered", then: () => "then" },
      callers: {
        first: { direct: ["then"], admit: () => true },
        second: { direct: ["then"], admit: () => true },
        sibling: { direct: ["capture"], admit: () => true },
      },
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BindInteractionsError);
    const failure = caught as BindInteractionsError;
    expect(failure.issues.map(issue => issue.caller).sort()).toEqual(["first", "second"]);
    expect(failure.issues.every(issue => issue.cause !== undefined)).toBe(true);
    expect(failure.issues.every(issue => Object.isFrozen(issue))).toBe(true);
    expect(Object.isFrozen(failure.issues)).toBe(true);
    expect(failure).not.toHaveProperty("bindings");
  });

  it("aggregates unknown aliases, duplicate selections, and missing admission across callers", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await bindInteractions(definitions, {
        installationId: "canvas:aggregate-preflight:1",
        realizationVersion: "aggregate-preflight-1",
        handlers: {
          move(input) { calls += 1; return input; },
          capture() { calls += 1; return "captured"; },
          render() { calls += 1; return "rendered"; },
        },
        callers: {
          unknown: { direct: ["erase"] as never, admit: () => true },
          duplicate: { direct: ["capture", "capture"], admit: () => true },
          missingAdmission: { direct: ["render"] } as never,
        },
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BindInteractionsError);
    const failure = caught as BindInteractionsError;
    expect(failure.issues.map(issue => issue.caller).sort()).toEqual(["duplicate", "missingAdmission", "unknown"]);
    expect(calls).toBe(0);
  });

  it("does not invoke handlers while starting, and freezes prototype-safe result maps", async () => {
    let calls = 0;
    const names = {
      constructor: { direct: ["capture"], admit: () => true },
      toString: { direct: ["render"], admit: () => true },
    } as const;
    const started = await bindInteractions(definitions, {
      installationId: "canvas:prototype:1", realizationVersion: "prototype-1",
      handlers: {
        move: input => { calls += 1; return input; },
        capture: () => { calls += 1; return "captured"; },
        render: () => { calls += 1; return "rendered"; },
      },
      callers: names,
    });
    expect(calls).toBe(0);
    for (const record of [started.projections, started.bindings, started.bindingControllers, started.callers]) {
      expect(Object.getPrototypeOf(record)).toBeNull();
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(keys(started.callers)).toEqual(["constructor", "toString"]);
    expect(Object.getPrototypeOf(started.callers.constructor)).toBeNull();
    expect(Object.getPrototypeOf(started.callers.toString)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(started.callers.constructor, "capture")?.writable).toBe(false);
    const withReservedAlias = {
      ...definitions,
      then: defineInteraction({ id: "canvas.then", output: Text }),
    } as const;
    await expect(bindInteractions(withReservedAlias, {
      installationId: "canvas:then:1", realizationVersion: "then-1",
      handlers: { move: input => input, capture: () => "captured", render: () => "rendered", then: () => "then" },
      callers: { editor: { direct: ["capture"], admit: () => true }, secondary: { direct: ["then"], admit: () => true } },
    })).rejects.toBeInstanceOf(BindInteractionsError);
  });

  it("rejects getters, symbols, sparse aliases, and malformed closed caller records before invoking code", async () => {
    const marker = Symbol("hostile");
    let getterCalls = 0;
    const badOptions = Object.defineProperties({}, {
      installationId: { enumerable: true, value: "canvas:hostile:1" },
      realizationVersion: { enumerable: true, value: "hostile-1" },
      handlers: { enumerable: true, value: { move: () => ({ x: 0, y: 0 }), capture: () => "x", render: () => "x" } },
      callers: { enumerable: true, get() { getterCalls += 1; return {}; } },
      [marker]: { enumerable: true, value: true },
    });
    await expect(bindInteractions(definitions, badOptions as never)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    const sparse = new Array<string>(1);
    await expect(bindInteractions(definitions, {
      installationId: "canvas:sparse:1", realizationVersion: "sparse-1",
      handlers: { move: () => ({ x: 0, y: 0 }), capture: () => "x", render: () => "x" },
      callers: { editor: { direct: sparse, admit: () => true } },
    } as never)).rejects.toThrow();
    await expect(bindInteractions(definitions, {
      installationId: "canvas:extra:1", realizationVersion: "extra-1",
      handlers: { move: () => ({ x: 0, y: 0 }), capture: () => "x", render: () => "x" },
      callers: { editor: { direct: ["capture"], admit: () => true, extra: true } },
    } as never)).rejects.toThrow();
  });
});
