import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { projectInteractions } from "@foxworth/boundary";
import { createMcpHandler, serveHost, tool, toolsFor } from "@foxworth/boundary/mcp";
import { createAdapterFixture, type AdapterContext } from "./helpers/adapter";

describe("MCP Binding adapter", () => {
  let client: Client | undefined;
  let handler: ReturnType<typeof createMcpHandler> | undefined;

  afterEach(async () => {
    await client?.close();
    await handler?.close();
    client = undefined;
    handler = undefined;
  });

  async function connect(role: AdapterContext["role"] = "owner") {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      list: {
        interaction: fixture.compiled.handles.list,
        modes: ["direct"],
      },
      create: {
        interaction: fixture.compiled.handles.create,
        modes: ["direct", "request"],
      },
      explode: {
        interaction: fixture.compiled.handles.explode,
        modes: ["direct"],
      },
    });
    const binding = await fixture.bind(projection);
    const context = Object.freeze({ role, marker: {} });
    handler = createMcpHandler({
      name: "todo-test",
      version: "2.0.0",
      binding,
      context: () => context,
      tools: [
        tool(projection.handles.list, {
          name: "todo_list",
          title: "Todo list",
        }),
        tool(projection.handles.create, {
          mode: "direct",
          name: "todo_create",
          description: "Create a todo through MCP",
        }),
        tool(projection.handles.create, {
          mode: "request",
          name: "todo_request",
        }),
        tool(projection.handles.explode, { name: "todo_explode" }),
      ],
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://test.local/mcp"),
      { fetch: (url, init) => handler!.fetch(new Request(url, init)) },
    );
    client = new Client(
      { name: "boundary-test-client", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    return { client, context, fixture };
  }

  it("publishes explicit names, docs, annotations, and exact v1 invocation outcomes", async () => {
    const connected = await connect();
    const listed = await connected.client.listTools();
    expect(listed.tools.map((entry) => entry.name).sort()).toEqual([
      "todo_create",
      "todo_explode",
      "todo_list",
      "todo_request",
    ]);
    expect(JSON.stringify(listed)).not.toContain("todos.hidden");
    expect(listed.tools.find((entry) => entry.name === "todo_list")).toMatchObject({
      title: "Todo list",
      description: "Read the current todo collection.",
      annotations: { readOnlyHint: true },
    });

    const result = await connected.client.callTool({
      name: "todo_create",
      arguments: { title: "From MCP" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      version: 1,
      interactionId: "todos.create",
      mode: "direct",
      certainty: "completed",
      result: { kind: "returned", value: { id: 1, title: "From MCP" } },
    });
    expect(result.structuredContent).toHaveProperty("bindingDigest");
    expect(connected.fixture.contexts).toEqual([connected.context]);
  });

  it("keeps request mode proposal-only and never exposes control administration", async () => {
    const connected = await connect();
    const result = await connected.client.callTool({
      name: "todo_request",
      arguments: { title: "Controlled" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      version: 1,
      interactionId: "todos.create",
      mode: "request",
      certainty: "not-started",
      result: { kind: "proposed", proposal: { title: "Controlled" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/approve|grant|execute|reconcile/u);
  });

  it("returns denied and sanitized fault outcomes without retrying", async () => {
    const denied = await connect("viewer");
    const deniedResult = await denied.client.callTool({
      name: "todo_create",
      arguments: { title: "Denied" },
    });
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult.structuredContent).toMatchObject({
      certainty: "not-started",
      result: { kind: "denied", code: "CALL_NOT_ADMITTED" },
    });
    expect(denied.fixture.rows).toEqual([]);

    await client?.close();
    await handler?.close();
    client = undefined;
    handler = undefined;
    const exploding = await connect();
    const fault = await exploding.client.callTool({
      name: "todo_explode",
      arguments: {},
    });
    expect(fault.isError).toBe(true);
    expect(fault.structuredContent).toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(JSON.stringify(fault)).not.toContain("private-adapter-secret");
    expect(exploding.fixture.contexts).toHaveLength(1);
  });

  it("presents every projected interaction and types extra.http.req", async () => {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
      create: { interaction: fixture.compiled.handles.create, modes: ["direct"] },
    });
    const binding = await fixture.bind(projection);
    const seen: Array<{ hasRequest: boolean; actor: string | null }> = [];
    handler = createMcpHandler({
      name: "todo-surface",
      version: "2.0.0",
      binding,
      context: ({ extra, request }) => {
        seen.push({
          hasRequest: request instanceof Request,
          actor: extra.http?.req instanceof Request
            ? extra.http.req.headers.get("x-host-actor")
            : null,
        });
        return Object.freeze({ role: "owner" as const, marker: {} });
      },
      // The tool list is fixed for the life of the handler. There is no
      // per-request predicate: a model that must see less gets a Binding of
      // a narrower Projection, which also keeps the interaction out of reach.
      tools: [
        tool(projection.handles.list, { name: "todo_list" }),
        tool(projection.handles.create, { mode: "direct", name: "todo_create" }),
      ],
    });
    const fetch = (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("x-host-actor", "agent-9");
      return handler!.fetch(new Request(url, { ...init, headers }));
    };
    const client = new Client(
      { name: "boundary-test-client", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch }),
    );
    expect((await client.listTools()).tools.map((entry) => entry.name).sort()).toEqual([
      "todo_create",
      "todo_list",
    ]);
    await client.callTool({
      name: "todo_create",
      arguments: { title: "Listed" },
    });
    await client.close();
    expect(seen.some((entry) => entry.hasRequest && entry.actor === "agent-9")).toBe(true);

    const serving = serveHost({
      doors: [],
      mcp: {
        path: "/mcp",
        name: "todo-surface",
        version: "2.0.0",
        binding,
        context: () => Object.freeze({ role: "owner" as const, marker: {} }),
        tools: toolsFor({ handles: { list: projection.handles.list } }),
      },
    });
    const listed = await serving.handler(
      new Request("http://test.local/mcp", { method: "GET" }),
    );
    expect(listed.status).not.toBe(404);
    await serving.dispose();
  });
});
