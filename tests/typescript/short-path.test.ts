import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectError, HostError, admitWhen, declaredInteractionError, defineInteraction, install, isDeclaredInteractionError, surface, type AnyCaller } from "@foxworth/boundary";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectInteractions } from "@foxworth/boundary/pipeline";
import { createControlRequestContributions } from "@foxworth/boundary/host/control";
import { createCheckedHandoff, createHandoffInvocation } from "@foxworth/boundary/handoff";
import { portableSchema, type JsonSchema } from "@foxworth/boundary/program";

const MoveInput = portableSchema<{ readonly x: number; readonly y: number }>({
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
});
const Text = portableSchema<string>({ type: "string" });
const Position = MoveInput;
type Actor = { readonly id: string; readonly role: "human" | "assistant" };

const definitions = {
  move: defineInteraction({ id: "canvas.move", input: MoveInput, output: Position, changes: ["canvas"] }),
  capture: defineInteraction({ id: "canvas.capture", output: Text, reads: ["canvas"] }),
  render: defineInteraction({ id: "canvas.render", output: Text, reads: ["canvas"] }),
} as const;

const keys = (record: object) => Object.keys(record).sort();

function canvas(seen: string[] = []) {
  let position = { x: 2, y: 4 };
  return {
    seen,
    handlers: {
      move(input: { readonly x: number; readonly y: number }, actor: Actor) {
        seen.push(actor.id);
        position = { x: input.x, y: input.y };
        return position;
      },
      capture(actor: Actor) { seen.push(actor.id); return `${position.x},${position.y}`; },
      render(actor: Actor) { seen.push(actor.id); return `render:${position.x},${position.y}`; },
    },
  };
}

const human: Actor = { id: "fox", role: "human" };
const assistant: Actor = { id: "agent-1", role: "assistant" };

describe("surface", () => {
  it("selects by alias, keeps declaration order, and refuses what it cannot expose", () => {
    const editor = surface(definitions, { call: ["render", "move"], propose: ["capture"] });
    expect(editor.call).toEqual(["move", "render"]);
    expect(editor.propose).toEqual(["capture"]);
    expect(Object.isFrozen(editor)).toBe(true);
    expect(surface.all(definitions).call).toEqual(["move", "capture", "render"]);
    expect(surface(definitions, {}).call).toEqual([]);
    const invalid = [
      () => surface(definitions, { call: ["erase"] as never }),
      () => surface(definitions, { call: ["move", "move"] }),
      () => surface(definitions, { call: ["move"], direct: [] } as never),
      () => surface(definitions, { call: new Array<string>(1) as never }),
      () => surface({ ...definitions, then: defineInteraction({ id: "canvas.then", output: Text }) }, { call: ["then"] as never }),
      () => surface.all({ ...definitions, propose: defineInteraction({ id: "canvas.propose", output: Text }) }),
    ];
    for (const attempt of invalid) {
      expect(attempt).toThrow(HostError);
      try { attempt(); } catch (error) {
        expect((error as HostError).code).toBe("INVALID_SURFACE");
        expect((error as HostError).message).toMatch(/expected .*; found .*; fix: /u);
      }
    }
  });
});

describe("install and connect", () => {
  it("composes the pipeline and lets a human read the live state after a mutation", async () => {
    const application = canvas();
    const app = await install(definitions, { id: "canvas:local:1", version: "build-7", handlers: application.handlers });
    const editor = await app.connect(surface.all(definitions), { admit: admitWhen((actor: Actor) => actor.role === "human") });
    const reader = await app.connect(surface(definitions, { call: ["capture", "render"] }), {
      admit: admitWhen((actor: Actor) => actor.role === "assistant"),
    });
    await expect(editor.move({ x: 8, y: 13 }, human)).resolves.toEqual({ x: 8, y: 13 });
    await expect(editor.capture(human)).resolves.toBe("8,13");
    await expect(reader.render(assistant)).resolves.toBe("render:8,13");
    expect(application.seen).toEqual(["fox", "fox", "agent-1"]);

    expect(app.id).toBe("canvas:local:1");
    expect(app.compiled.handles.move.interactionId).toBe("canvas.move");
    expect(app.manifest.installationId).toBe("canvas:local:1");
    expect(app.program).toBe(app.compiled.program);
    expect(editor.manifest.interactions.map((item) => item.alias)).toEqual(["capture", "move", "render"]);
    expect(reader.manifest.interactions.map((item) => item.alias)).toEqual(["capture", "render"]);
    expect(app.binding(reader).manifest).toBe(reader.manifest);
    expect(reader.manifest.interactions.every((item) => item.realizationId.endsWith(":direct:build-7"))).toBe(true);
  });

  it("generates a visible installation id when the host passes none", async () => {
    const first = await install(definitions, { version: "v1", handlers: canvas().handlers });
    const second = await install(definitions, { version: "v1", handlers: canvas().handlers });
    expect(first.id).toMatch(/^generated:[0-9a-f]{12}:[0-9a-f]{12}$/u);
    expect(second.id).not.toBe(first.id);
    expect(first.manifest.installationId).toBe(first.id);
  });

  it("preserves zero-input, one-input, and contextless handler conventions", async () => {
    const app = await install(definitions, {
      version: "arity-1",
      handlers: {
        move: (input) => ({ x: input.x, y: input.y }),
        capture: () => "captured",
        render: () => "rendered",
      },
    });
    const screen = await app.connect(surface.all(definitions), { admit: admitWhen(() => true) });
    await expect(screen.move({ x: 1, y: 3 })).resolves.toEqual({ x: 1, y: 3 });
    await expect(screen.capture()).resolves.toBe("captured");
    await expect(screen.render()).resolves.toBe("rendered");
  });

  it("evaluates admission on every call with the current actor and does not dispatch a denied call", async () => {
    let allowed = true;
    let calls = 0;
    const app = await install(definitions, {
      version: "admission-1",
      handlers: {
        move(input, _actor: Actor) { calls += 1; return input; },
        capture() { calls += 1; return "captured"; },
        render() { calls += 1; return "rendered"; },
      },
    });
    const editor = await app.connect(surface(definitions, { call: ["move"] }), {
      admit: admitWhen((actor: Actor) => allowed && actor.id === "fox"),
    });
    await editor.move({ x: 1, y: 2 }, human);
    allowed = false;
    await expect(editor.move({ x: 3, y: 4 }, human)).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    expect(calls).toBe(1);
  });

  it("awaits asynchronous admission and preserves a thrown admission as not started", async () => {
    let decision: "allow" | "deny" | "reject" = "allow";
    let calls = 0;
    const app = await install(definitions, {
      version: "async-admission-1",
      handlers: {
        move(input, _actor: Actor) { calls += 1; return input; },
        capture() { calls += 1; return "captured"; },
        render() { calls += 1; return "rendered"; },
      },
    });
    const editor = await app.connect(surface(definitions, { call: ["move"] }), {
      admit: admitWhen(async (actor: Actor) => {
        if (decision === "reject") throw new Error(`policy failed for ${actor.id}`);
        await Promise.resolve();
        return decision === "allow";
      }),
    });
    await expect(editor.move({ x: 1, y: 2 }, human)).resolves.toEqual({ x: 1, y: 2 });
    decision = "deny";
    await expect(editor.move({ x: 3, y: 4 }, human)).rejects.toMatchObject({ cause: "denied", certainty: "not-started" });
    decision = "reject";
    await expect(editor.move({ x: 5, y: 6 }, human)).rejects.toMatchObject({ cause: "admission-failed", certainty: "not-started" });
    expect(calls).toBe(1);
  });

  it("keeps selected methods narrow and the caller free of any controller", async () => {
    let moveCalls = 0;
    const app = await install(definitions, {
      version: "narrow-1",
      handlers: { move: (input) => { moveCalls += 1; return input; }, capture: () => "captured", render: () => "rendered" },
    });
    const reader = await app.connect(surface(definitions, { call: ["capture"] }), { admit: admitWhen(() => true) });
    expect(Object.keys(reader)).toEqual(["capture"]);
    expect(Object.keys(reader.propose)).toEqual([]);
    expect((reader as Record<string, unknown>).move).toBeUndefined();
    expect("revoke" in reader).toBe(false);
    expect(Object.getPrototypeOf(reader)).toBeNull();
    expect(Object.isFrozen(reader)).toBe(true);
    expect(app.binding(reader).resolve("canvas.move")).toBeUndefined();
    expect(reader.manifest.interactions).toHaveLength(1);
    expect(reader.manifest.bindingDigest).toMatch(/^sha256:/u);
    expect(moveCalls).toBe(0);
    await expect(reader.capture()).resolves.toBe("captured");
    expect(() => app.binding({} as never)).toThrow(HostError);
  });

  it("snapshots the surface selection and the handler functions at install time", async () => {
    const aliases: Array<"move" | "capture" | "render"> = ["move", "capture"];
    const handlers = {
      move(input: { readonly x: number; readonly y: number }, _actor: Actor) { return { x: input.x, y: input.y }; },
      capture(_actor: Actor) { return "original capture"; },
      render(_actor: Actor) { return "original render"; },
    };
    const selected = surface(definitions, { call: aliases });
    const pending = install(definitions, { version: "snapshot-1", handlers });
    aliases.splice(0, aliases.length, "render");
    handlers.move = (_input, _actor) => ({ x: -1, y: -1 });
    handlers.capture = () => "mutated capture";
    const app = await pending;
    const editor = await app.connect(selected, { admit: admitWhen((actor: Actor) => actor.role === "human") });
    expect(keys(editor)).toEqual(["capture", "move"]);
    await expect(editor.move({ x: 4, y: 9 }, human)).resolves.toEqual({ x: 4, y: 9 });
    await expect(editor.capture(human)).resolves.toBe("original capture");
  });

  it("revokes one caller or the whole installation from the host-held app", async () => {
    const app = await install(definitions, {
      version: "revoke-1",
      handlers: { move: (input) => input, capture: () => "captured", render: () => "rendered" },
    });
    const editor = await app.connect(surface(definitions, { call: ["capture"] }), { admit: admitWhen(() => true) });
    const reader = await app.connect(surface(definitions, { call: ["render"] }), { admit: admitWhen(() => true) });
    expect(app.revoke(editor)).toBe(true);
    expect(app.revoke(editor)).toBe(false);
    await expect(editor.capture()).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    await expect(reader.render()).resolves.toBe("rendered");
    expect(app.revoked).toBe(false);
    expect(app.revoke()).toBe(true);
    expect(app.revoked).toBe(true);
    await expect(reader.render()).rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    await expect(app.connect(surface(definitions, { call: ["render"] }), { admit: admitWhen(() => true) }))
      .rejects.toBeInstanceOf(ConnectError);
    expect(() => app.revoke({} as never)).toThrow(HostError);
  });

  it("preserves declared errors and unknown failures without retrying handlers", async () => {
    const Problem = portableSchema<{ readonly code: string }>({
      type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
    });
    const source = {
      fail: defineInteraction({ id: "canvas.fail", input: Text, output: Text, errors: { unavailable: Problem } }),
    } as const;
    const declared = declaredInteractionError(source.fail, "unavailable", { code: "locked" });
    let declaredCalls = 0;
    let unknownCalls = 0;
    const app = await install(source, {
      version: "failure-1",
      handlers: {
        fail(input) {
          if (input === "declared") { declaredCalls += 1; throw declared; }
          unknownCalls += 1;
          throw new Error("acknowledgement lost");
        },
      },
    });
    const editor = await app.connect(surface.all(source), { admit: admitWhen(() => true) });
    let caught: unknown;
    try { await editor.fail("declared"); } catch (error) { caught = error; }
    expect(isDeclaredInteractionError(caught, app.compiled.handles.fail, "unavailable")).toBe(true);
    await expect(editor.fail("unknown")).rejects.toMatchObject({ cause: "realization-failed", certainty: "unknown" });
    expect(declaredCalls).toBe(1);
    expect(unknownCalls).toBe(1);
  });

  it("returns the explicit pipeline's artifacts for the same inputs", async () => {
    const shortHandlers = canvas().handlers;
    const explicitHandlers = canvas().handlers;
    const app = await install(definitions, { id: "canvas:equivalence:1", version: "equivalence-1", handlers: shortHandlers });
    const editor = await app.connect(surface(definitions, { call: ["move", "capture", "render"] }), {
      admit: admitWhen(() => true),
    });

    const compiled = await compileInteractions(definitions);
    const installed = await installInteractions(compiled, {
      installationId: "canvas:equivalence:1",
      realizationIds: {
        move: { direct: "canvas.move:direct:equivalence-1" },
        capture: { direct: "canvas.capture:direct:equivalence-1" },
        render: { direct: "canvas.render:direct:equivalence-1" },
      },
      implementations: implementInteractions<typeof definitions, Actor>(definitions, explicitHandlers),
    });
    const projection = await projectInteractions(compiled, {
      move: { interaction: compiled.handles.move, modes: ["direct"] },
      capture: { interaction: compiled.handles.capture, modes: ["direct"] },
      render: { interaction: compiled.handles.render, modes: ["direct"] },
    });
    const bound = await bindSurface(projection, installed.installation, { admit: () => ({ decision: "allow" }) });
    if (bound.status !== "bound") throw new Error("explicit pipeline did not bind");

    expect(app.program).toEqual(compiled.program);
    expect(app.manifest).toEqual(installed.installation.manifest);
    expect(editor.manifest).toEqual(bound.binding.manifest);
    expect(app.binding(editor).manifest).toEqual(bound.binding.manifest);

    await editor.move({ x: 5, y: 9 }, human);
    await bound.binding.connect().call(projection.handles.move, { x: 5, y: 9 }, human);
    await expect(editor.capture(human)).resolves.toBe(await bound.binding.connect().call(projection.handles.capture, human));
  });

  it("keeps the contract and Program digests of the reviewed lifecycle vector", async () => {
    const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../conformance/v1/host-lifecycle.json", import.meta.url)), "utf8")) as {
      interaction: { id: string; inputSchema: JsonSchema; outputSchema: JsonSchema; reads: string[]; changes: string[]; contractDigest: string; programDigest: string };
    };
    const todos = {
      create: defineInteraction({
        id: vector.interaction.id,
        input: portableSchema<{ readonly title: string }>(vector.interaction.inputSchema),
        output: portableSchema<{ readonly id: string; readonly title: string }>(vector.interaction.outputSchema),
        reads: vector.interaction.reads,
        changes: vector.interaction.changes,
      }),
    } as const;
    const app = await install(todos, { version: "vector-1", handlers: { create: (input) => ({ id: "1", title: input.title }) } });
    expect(app.compiled.handles.create.contractDigest).toBe(vector.interaction.contractDigest);
    expect(app.program.programDigest).toBe(vector.interaction.programDigest);
    const caller = await app.connect(surface.all(todos), { admit: admitWhen(() => true) });
    expect(caller.manifest.expectedProgramDigest).toBe(vector.interaction.programDigest);
    expect(caller.manifest.actualProgramDigest).toBe(vector.interaction.programDigest);
  });

  it("refuses what the installation cannot realize with an exhaustive, actionable report", async () => {
    const app = await install(definitions, { id: "canvas:unrealized:1", version: "u-1", handlers: canvas().handlers });
    const proposing = surface(definitions, { call: ["capture"], propose: ["move"] });
    const outcome = await app.tryConnect(proposing, { admit: admitWhen(() => true) });
    expect(outcome.status).toBe("unrealized");
    if (outcome.status !== "unrealized") throw new Error("expected unrealized");
    expect(outcome.report.installationId).toBe("canvas:unrealized:1");
    expect(outcome.report.issues).toEqual([
      expect.objectContaining({ alias: "move", interactionId: "canvas.move", mode: "request", reason: "missing-request" }),
    ]);
    let caught: unknown;
    try { await app.connect(proposing, { admit: admitWhen(() => true) }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ConnectError);
    const failure = caught as ConnectError;
    expect(failure.report).toEqual(outcome.report);
    expect(failure.expected).toContain('installation "canvas:unrealized:1"');
    expect(failure.found).toContain("move (canvas.move, request): missing-request");
    expect(failure.fix).toContain("contribute a Control request");
    expect(failure.message).toContain("fix:");

    // A surface over a different declaration of the same interaction is refused on contract, not adopted:
    // this surface expects a move that changes nothing, and the installed one changes the canvas.
    const narrower = {
      ...definitions,
      move: defineInteraction({ id: "canvas.move", input: MoveInput, output: Position, changes: [] }),
    } as const;
    const stale = await app.tryConnect(surface(narrower, { call: ["move"] }), { admit: admitWhen(() => true) });
    expect(stale.status).toBe("unrealized");
    if (stale.status === "unrealized") {
      expect(stale.report.issues.map((issue) => issue.reason)).toEqual(["incompatible-contract"]);
    }
    const foreign = await app.tryConnect(surface({ other: defineInteraction({ id: "other.thing", output: Text }) }, { call: ["other"] }), {
      admit: admitWhen(() => true),
    });
    expect(foreign.status).toBe("unrealized");
  });

  it("rejects malformed options before running any host code", async () => {
    let calls = 0;
    const handlers = { move: (input: { x: number; y: number }) => { calls += 1; return input; }, capture: () => "x", render: () => "x" };
    const attempts: Array<() => Promise<unknown>> = [
      () => install(definitions, { version: "x", handlers, dispatch: { targets: {}, dispatchers: {} } } as never),
      () => install(definitions, { version: "x" } as never),
      () => install(definitions, { version: "", handlers }),
      () => install(definitions, { version: "x", handlers, extra: true } as never),
      () => install(definitions, { version: "x", handlers, id: 7 } as never),
      () => install(definitions, { version: "x", handlers, requests: {} } as never),
      () => install(definitions, Object.defineProperty({ version: "x" }, "handlers", { enumerable: true, get: () => handlers }) as never),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(HostError);
    const app = await install(definitions, { version: "x", handlers });
    await expect(app.connect({ call: ["move"], propose: [], definitions } as never, { admit: admitWhen(() => true) })).rejects.toMatchObject({ code: "INVALID_SURFACE" });
    await expect(app.connect(surface(definitions, { call: ["move"] }), {} as never)).rejects.toMatchObject({ code: "INVALID_ADMISSION" });
    expect(calls).toBe(0);
  });

  it("exposes propose methods for request contributions and never runs the effect", async () => {
    const requests: string[] = [];
    let moves = 0;
    const app = await install(definitions, {
      id: "canvas:propose:1",
      version: "p-1",
      handlers: {
        move(input, _actor: Actor) { moves += 1; return input; },
        capture(_actor: Actor) { return "captured"; },
        render(_actor: Actor) { return "rendered"; },
      },
      requests: (compiled) => createControlRequestContributions<typeof definitions, Actor>(compiled, {
        move: {
          interaction: compiled.handles.move,
          controlDigest: compiled.handles.move.contractDigest,
          previewSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
          request(input, actor) { requests.push(actor.id); return { x: input.x, y: input.y }; },
        },
      }),
    });
    expect(app.manifest.catalog.interactions.find((entry) => entry.interactionId === "canvas.move")?.request?.realizationId)
      .toBe("canvas.move:request:p-1");
    const reviewer = await app.connect(surface(definitions, { call: ["capture"], propose: ["move"] }), {
      admit: admitWhen((actor: Actor) => actor.role === "assistant"),
    });
    expect(Object.keys(reviewer)).toEqual(["capture"]);
    expect(Object.keys(reviewer.propose)).toEqual(["move"]);
    expect((reviewer as Record<string, unknown>).move).toBeUndefined();
    await expect(reviewer.propose.move({ x: 1, y: 2 }, assistant)).resolves.toEqual({ x: 1, y: 2 });
    expect(requests).toEqual(["agent-1"]);
    expect(moves).toBe(0);
    expect(reviewer.manifest.interactions.map((item) => `${item.alias}:${item.mode}`)).toEqual(["capture:direct", "move:request"]);
    const both = await app.connect(surface(definitions, { call: ["move"], propose: ["move"] }), { admit: admitWhen(() => true) });
    expect(both.manifest.interactions.map((item) => `${item.alias}:${item.mode}`)).toEqual(["move:direct", "move:request"]);
    await expect(both.move({ x: 3, y: 4 }, human)).resolves.toEqual({ x: 3, y: 4 });
    expect(moves).toBe(1);
  });

  it("installs native dispatchers over host targets", async () => {
    const seen: string[] = [];
    const app = await install<typeof definitions, { move: string; capture: string; render: string }, Actor>(definitions, {
      version: "native-1",
      dispatch: {
        targets: { move: "canvas", capture: "camera", render: "renderer" },
        dispatchers: {
          move({ target, input, context, outcomes }) { seen.push(`${target}:${context.id}`); return outcomes.returned(input); },
          capture({ target, outcomes }) { return outcomes.returned(target); },
          render({ outcomes }) { return outcomes.denied("host.policy.denied"); },
        },
      },
    });
    const editor = await app.connect(surface.all(definitions), { admit: admitWhen(() => true) });
    await expect(editor.move({ x: 1, y: 1 }, human)).resolves.toEqual({ x: 1, y: 1 });
    await expect(editor.capture(human)).resolves.toBe("camera");
    await expect(editor.render(human)).rejects.toMatchObject({ cause: "denied" });
    expect(seen).toEqual(["canvas:fox"]);
  });

  it("hands adapters a Handoff seam that validates into this exact Binding", async () => {
    const app = await install(definitions, { id: "canvas:handoff:1", version: "h-1", handlers: canvas().handlers });
    const reader = await app.connect(surface(definitions, { call: ["capture"] }), {
      admit: admitWhen((actor: Actor) => actor.role === "assistant"),
    });
    const seam: AnyCaller<Actor>["handoff"] = reader.handoff;
    expect(Object.keys(seam).sort()).toEqual(["invoke", "manifest", "resolve"]);
    expect(seam.manifest).toBe(reader.manifest);
    const checked = await createCheckedHandoff<Actor>(seam);
    const invocation = await createHandoffInvocation(reader.manifest, "canvas.capture", "direct", null);
    const outcome = await checked.invoke(invocation, assistant);
    expect(outcome.result).toEqual({ kind: "returned", value: "2,4" });
    await expect(createHandoffInvocation(reader.manifest, "canvas.move", "direct", { x: 1, y: 1 })).rejects.toThrow();
    const denied = await checked.invoke(invocation, human);
    expect(denied.result.kind).toBe("denied");
  });
});
