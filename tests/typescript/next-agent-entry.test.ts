import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import "./helpers/folio-environment";
import { createProjectionClient, handlesFromBinding } from "../../packages/callers/client/client";
import { fetchTransport } from "../../packages/adapters/http/protocol";
import { registerWebMcpTransport, type ModelContextPort, type ModelContextTool } from "../../packages/callers/webmcp";
import { webMcpTool } from "../../packages/callers/webmcp";

const { folioMcpHandler, agentBoundaryHandler } = await import("../../examples/apps/typescript/document-workspace/lib/agent-entry");
const { GET: mcpGET } = await import("../../examples/apps/typescript/document-workspace/app/api/mcp/route");
const { POST: agentBoundaryPOST } = await import("../../examples/apps/typescript/document-workspace/app/api/agent-boundary/[...path]/route");

describe("Folio MCP and browser agent entries", () => {
  const clients: Client[] = [];
  const registrations: Array<{ dispose(): void }> = [];

  afterEach(async () => {
    for (const registration of registrations.splice(0)) registration.dispose();
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connect(token: string) {
    const client = new Client({ name: "folio-entry-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("https://folio.test/api/mcp"), {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return folioMcpHandler.fetch(new Request(input, { ...init, headers }));
      },
    }));
    return client;
  }

  it("selects MCP tools by bearer delegation and never exposes approval administration", async () => {
    const reader = await connect("folio-local-read");
    expect((await reader.listTools()).tools.map((item) => item.name).sort()).toEqual(["getDocument", "publicationStatus"]);

    const drafter = await connect("folio-local-draft");
    const names = (await drafter.listTools()).tools.map((item) => item.name).sort();
    expect(names).toEqual(["getDocument", "publicationStatus", "requestPublish", "saveDraft"]);
    expect(names.join(" ")).not.toMatch(/approve|grant|execute|admin/u);
    // Listing proves the request-only surface is present; approval remains
    // deliberately absent from the MCP catalog.
  });

  it("keeps foreign delegation and missing credentials outside host authority", async () => {
    const foreign = await connect("folio-local-foreign");
    const result = await foreign.callTool({ name: "getDocument", arguments: { id: "doc-1" } });
    expect(result.isError).toBe(true);
    await expect(mcpGET(new Request("https://folio.test/api/mcp", { method: "GET" }))).resolves.toMatchObject({ status: 401 });
  });

  it("rejects a forged cross-origin request before protocol validation", async () => {
    const response = await agentBoundaryPOST(new Request("https://localhost/api/agent-boundary/invoke", {
      method: "POST",
      headers: { cookie: "boundary_demo_session=alice", origin: "https://foreign.invalid", host: "folio.test" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
  });

  it("hydrates browser handles over same-origin protocol and registers a disposable WebMCP port", async () => {
    const browserFetch = (input: RequestInfo | URL, init?: RequestInit) => agentBoundaryHandler(new Request(input, {
      ...init,
      headers: { ...init?.headers, cookie: "boundary_demo_session=alice", origin: "https://folio.test", host: "folio.test" },
    }));
    const client = createProjectionClient(fetchTransport({ baseUrl: "https://folio.test/api/agent-boundary", fetch: browserFetch }));
    const handles = await handlesFromBinding(client);
    expect(Object.keys(handles)).toEqual(["get", "publicationStatus", "publish", "save"]);
    const manifest = await client.inspect();

    const registered = new Map<string, ModelContextTool>();
    const port: ModelContextPort = { async registerTool(tool) { registered.set(tool.name, tool); } };
    const registration = await registerWebMcpTransport({
      modelContext: port,
      transport: fetchTransport({ baseUrl: "https://folio.test/api/agent-boundary", fetch: browserFetch }),
      tools: [
        webMcpTool(manifest, "get", { mode: "call", name: "getDocument" }),
        webMcpTool(manifest, "save", { mode: "call", name: "saveDraft" }),
        webMcpTool(manifest, "publish", { mode: "propose", name: "requestPublish" }),
      ],
    });
    registrations.push(registration);
    expect([...registered.keys()]).toEqual(["getDocument", "saveDraft", "requestPublish"]);
    registration.dispose();
  });
});
