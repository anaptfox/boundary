import { createMcpHandler, serveHost, toolsFor } from "@foxworth/boundary/mcp";
import { createTodoHost, type TodoHost } from "./host";

const SCREEN_PROTOCOL = "/_boundary/screen";
const AGENT_PROTOCOL = "/_boundary/agent";
const MCP_PATH = "/mcp";

export function createTodoMcpHandler(host: TodoHost) {
  return createMcpHandler({
    name: "todos",
    version: "1.0.0",
    binding: host.agentBinding,
    context: () => host.agentContext,
    tools: toolsFor(host.agent),
  });
}

export async function createTodoServing() {
  const host = await createTodoHost();
  const serving = serveHost({
    doors: [
      {
        binding: host.screenBinding,
        context: () => host.screenContext,
        path: SCREEN_PROTOCOL,
      },
      {
        binding: host.agentBinding,
        context: () => host.agentContext,
        path: AGENT_PROTOCOL,
      },
    ],
    mcp: {
      path: MCP_PATH,
      name: "todos",
      version: "1.0.0",
      binding: host.agentBinding,
      context: () => host.agentContext,
      tools: toolsFor(host.agent),
    },
  });

  return {
    host,
    handler: serving.handler,
    paths: serving.paths,
    async dispose() {
      await serving.dispose();
    },
  };
}
