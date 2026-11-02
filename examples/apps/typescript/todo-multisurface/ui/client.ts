import {
  isWebMcpAvailable,
  registerWebMcpTransport,
  webMcpTools,
  type WebMcpRegistration,
} from "@foxworth/boundary/webmcp";
import {
  createProjectionClient,
  pinProjectionReferences,
} from "@foxworth/boundary/client";
import { fetchTransport } from "@foxworth/boundary/http/protocol";
import { screenReferences } from "../references";

const SCREEN_PROTOCOL = "/_boundary/screen";
const AGENT_PROTOCOL = "/_boundary/agent";

export async function bootTodoUi() {
  const screenTransport = fetchTransport({ baseUrl: SCREEN_PROTOCOL });
  const agentTransport = fetchTransport({ baseUrl: AGENT_PROTOCOL });
  const screenClient = createProjectionClient(screenTransport);
  const agentClient = createProjectionClient(agentTransport);
  const handles = await pinProjectionReferences(screenClient, screenReferences);
  let webmcp: WebMcpRegistration | undefined;
  if (isWebMcpAvailable()) {
    const agentManifest = await agentClient.inspect();
    webmcp = await registerWebMcpTransport({
      transport: agentTransport,
      tools: webMcpTools(agentManifest, { list: { untrustedContentHint: true } }),
    });
  }
  return {
    handles,
    screenClient,
    agentClient,
    webmcp,
  };
}

export type TodoUiRuntime = Awaited<ReturnType<typeof bootTodoUi>>;
