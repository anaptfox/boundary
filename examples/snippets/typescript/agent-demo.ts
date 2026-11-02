/**
 * The README's first demo: declare two interactions, install the application's
 * functions, connect a narrow surface for an assistant, and serve it over MCP.
 * Executed by tests/typescript/docs-examples.test.ts against an in-process
 * MCP client; a real deployment mounts the same handler on its HTTP server.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// #region declare
import { z } from "zod";
import { admitWhen, defineInteraction, install, surface } from "@foxworth/boundary";
import { createMcpHandler, toolsFor } from "@foxworth/boundary/mcp";

const Document = z.strictObject({ id: z.string(), title: z.string() });

export const docs = {
  search: defineInteraction({
    id: "documents.search",
    input: z.strictObject({ query: z.string().min(1) }),
    output: z.array(Document),
    reads: ["documents"],
    description: "Find documents whose title contains the query.",
  }),
  delete: defineInteraction({
    id: "documents.delete",
    input: z.strictObject({ id: z.string() }),
    output: z.strictObject({ deleted: z.boolean() }),
    changes: ["documents"],
    description: "Delete one document by id.",
  }),
} as const;
// #endregion declare

type Actor = Readonly<{ id: string; kind: "editor" | "assistant" }>;

export async function createAgentDemo() {
  const documents = new Map([
    ["spring-plans", { id: "spring-plans", title: "Spring plans" }],
    ["spring-budget", { id: "spring-budget", title: "Spring budget" }],
  ]);

  // #region install
  const app = await install(docs, {
    version: "documents-1",
    handlers: {
      search: ({ query }, _actor: Actor) =>
        [...documents.values()].filter((entry) => entry.title.toLowerCase().includes(query.toLowerCase())),
      delete: ({ id }, _actor: Actor) => ({ deleted: documents.delete(id) }),
    },
  });
  // #endregion install

  // #region connect
  // The assistant sees search and nothing else. The editor sees both.
  const assistant = await app.connect(surface(docs, { call: ["search"] }), {
    admit: admitWhen((actor: Actor) => actor.kind === "assistant", "Assistant required"),
  });
  const editor = await app.connect(surface.all(docs), {
    admit: admitWhen((actor: Actor) => actor.kind === "editor", "Editor required"),
  });
  // #endregion connect

  // #region serve
  // One MCP tool per selected interaction; the host still admits every call.
  const mcp = createMcpHandler({
    name: "documents",
    version: "1.0.0",
    caller: assistant,
    context: () => ({ id: "assistant", kind: "assistant" as const }),
    tools: toolsFor(assistant),
  });
  // #endregion serve

  return { app, assistant, editor, mcp, documents };
}

/** Drive the served tools with an in-process MCP client. */
export async function runAgentDemo() {
  const demo = await createAgentDemo();
  const client = new Client({ name: "readme-agent", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://demo.local/mcp"), {
      fetch: (url, init) => demo.mcp.fetch(new Request(url, init)),
    }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const found = await client.callTool({ name: "documents.search", arguments: { query: "spring" } });
    const text = (found.content as Array<{ text: string }>)[0]!.text;
    const editorSees = Object.keys(demo.editor);
    const assistantSees = Object.keys(demo.assistant);
    return { tools, firstLine: text.split("\n")[0]!, assistantSees, editorSees };
  } finally {
    await client.close();
    await demo.mcp.close();
  }
}
