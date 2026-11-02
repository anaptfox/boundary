import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InteractionFault } from "@foxworth/boundary";
import { createTodoHost } from "../../examples/apps/typescript/todo-multisurface/host";
import { runTodoHost } from "../../examples/apps/typescript/todo-multisurface/run";
import { createTodoMcpHandler } from "../../examples/apps/typescript/todo-multisurface/serve";

describe("Todo MVP fixture", () => {
  it("runs one Installation through screen and agent callers", async () => {
    const result = await runTodoHost();

    expect(result.listed).toEqual([
      { id: 1, title: "Ship Boundary", completed: false },
      { id: 2, title: "Teach Boundary", completed: false },
    ]);
    expect(result.created).toEqual({
      id: 3,
      title: "Ship the fixture",
      completed: false,
    });
    expect(result.agentListed).toHaveLength(3);
    expect(result.agentCompleted).toEqual({
      id: 3,
      title: "Ship the fixture",
      completed: true,
    });
    expect(result.screenCompleted).toEqual({
      id: 1,
      title: "Ship Boundary",
      completed: true,
    });
    expect(result.screenReopened).toEqual({
      id: 1,
      title: "Ship Boundary",
      completed: false,
    });
    expect(result.cleared).toEqual({ removed: 3 });
  });

  it("denies the wrong caller and rejects an unselected interaction", async () => {
    const host = await createTodoHost();
    const screenClear = host.screenBinding.resolve("todos.clear");
    if (!screenClear) throw new Error("screen clear interaction was not bound");

    await expect(
      host.agentBinding.invoke(
        { interaction: screenClear, mode: "direct", input: null },
        host.agentContext,
      ),
    ).rejects.toMatchObject({
      cause: "invalid-invocation",
      certainty: "not-started",
    });

    await expect(
      host.agentCaller.call(
        host.agent.handles.complete,
        { id: 2 },
        host.screenContext,
      ),
    ).rejects.toMatchObject({
      cause: "denied",
      certainty: "not-started",
    });
    await expect(
      host.agentCaller.call(
        host.agent.handles.complete,
        { id: 2 },
        host.screenContext,
      ),
    ).rejects.toBeInstanceOf(InteractionFault);
  });

  it("exposes the agent Binding as regular MCP tools", async () => {
    const host = await createTodoHost();
    const handler = createTodoMcpHandler(host);
    const transport = new StreamableHTTPClientTransport(
      new URL("http://test.local/mcp"),
      { fetch: (url, init) => handler.fetch(new Request(url, init)) },
    );
    const client = new Client(
      { name: "todo-mvp-test", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((entry) => entry.name).sort()).toEqual([
      "todos.complete",
      "todos.list",
      "todos.reopen",
    ]);
    expect(listed.tools.find((entry) => entry.name === "todos.complete")).toMatchObject({
      description: "Mark one todo complete.",
      annotations: { readOnlyHint: false },
    });

    const completed = await client.callTool({
      name: "todos.complete",
      arguments: { id: 1 },
    });
    expect(completed.isError).toBeFalsy();
    expect(completed.structuredContent).toMatchObject({
      version: 1,
      interactionId: "todos.complete",
      mode: "direct",
      certainty: "completed",
      result: {
        kind: "returned",
        value: { id: 1, title: "Ship Boundary", completed: true },
      },
    });
    expect(host.store.get(1)).toEqual({
      id: 1,
      title: "Ship Boundary",
      completed: true,
    });

    await client.close();
    await handler.close();
  });
});
