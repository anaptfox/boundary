import { describe, expect, it } from "vitest";
import {
  createTodoHttpExample,
  runHttpAdapterExample,
} from "../../examples/snippets/typescript/http-adapter";
import { runWebMcpAdapterExample } from "../../examples/snippets/typescript/webmcp-adapter";
import { runAgentDemo } from "../../examples/snippets/typescript/agent-demo";
import { runReadmeExample } from "../../examples/snippets/typescript/readme";
import { runWalkthroughExample } from "../../examples/snippets/typescript/walkthrough";
import {
  createHostLifecycleExample,
  runHostLifecycleExample,
} from "../../examples/snippets/typescript/host-lifecycle";

describe("public documentation examples", () => {
  it("serves the README's assistant surface over MCP and keeps delete out of its reach", async () => {
    const result = await runAgentDemo();
    expect(result.tools).toEqual(["documents.search"]);
    expect(result.firstLine).toBe("documents.search completed and returned a value (certainty: completed).");
    expect(result.assistantSees).toEqual(["search"]);
    expect(result.editorSees).toEqual(["search", "delete"]);
  });

  it("runs the additional Todo projection-helper example", async () => {
    const result = await runReadmeExample();
    expect(result.done).toEqual({ id: 1, title: "Ship Boundary", done: true });
    expect(result.remaining).toBe(2);
    expect(Object.keys(result.screen.handles)).toEqual(["complete", "clear"]);
    expect(Object.keys(result.agent.handles)).toEqual(["complete"]);
  });

  it("runs the additional Todo lifecycle and refusal cases", async () => {
    const result = await runWalkthroughExample();
    expect(result.byScreen).toMatchObject({ id: 1, done: true });
    expect(result.byAgent).toMatchObject({ id: 2, done: true });
    expect(result.denied).toMatchObject({ cause: "denied" });
    expect(result.notFound).toEqual({ id: 999 });
    expect(result.unrealized.status).toBe("unrealized");
    expect(result.stale.status).toBe("unrealized");
    expect(result.remaining).toBe(2);
  });

  it("sends the same interaction through two caller-specific projections", async () => {
    const result = await runHostLifecycleExample();

    expect(result.screen).toMatchObject({
      kind: "returned",
      value: { id: 1, title: "Ship Boundary", completed: true },
    });
    expect(result.agent).toMatchObject({
      kind: "returned",
      value: { id: 2, title: "Teach Boundary", completed: true },
    });
    expect(result.dispatches).toEqual([
      "todos.complete",
      "todos.complete",
    ]);
    expect(result.unselectedError).toMatchObject({
      code: "INTERACTION_NOT_EXPOSED",
    });
    expect(result.staleContractError).toMatchObject({
      code: "STALE_CONTRACT",
    });

    const fixture = await createHostLifecycleExample();
    await expect(fixture.callAgent(fixture.clearReference, {})).rejects
      .toMatchObject({ code: "INTERACTION_NOT_EXPOSED" });
    await expect(
      fixture.callAgent(fixture.staleCompleteReference, { id: 2 }),
    ).rejects.toMatchObject({ code: "STALE_CONTRACT" });
    expect(fixture.dispatches).toEqual([]);
  });

  it("projects only declared HTTP routes with request-derived context", async () => {
    const result = await runHttpAdapterExample();
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      interactionId: "todos.create",
      certainty: "completed",
      result: {
        kind: "returned",
        value: { id: 1, title: "Through HTTP" },
      },
    });

    const { handler } = await createTodoHttpExample();
    const denied = await handler(
      new Request("https://example.test/todos", {
        method: "POST",
        body: JSON.stringify({ title: "Denied" }),
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("projects selected interactions through an injectable WebMCP host", async () => {
    const registered = new Map<string, { name: string }>();
    const names = await runWebMcpAdapterExample({
      async registerTool(tool, options) {
        registered.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => {
          registered.delete(tool.name);
        });
      },
    });
    expect(names.sort()).toEqual(["todos.create", "todos.list"]);
    expect([...registered.keys()].sort()).toEqual(["todos.create", "todos.list"]);
  });
});
