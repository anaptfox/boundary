import { createMcpHandler, tool } from "@foxworth/boundary/mcp";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { demoContextFromCookie, type DemoContext } from "./context";
import { requireBearerAuth, requireScopes, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { localTokenVerifier } from "./local-auth";
import { caller, readCaller } from "./boundary";
import { tracedContext } from "./activity";

function agentContextFromAuth(info: AuthInfo): DemoContext {
  return Object.freeze({
    session: "alice",
    documentId: "doc-1",
    canEdit: true,
    delegation: Object.freeze({
      executor: info.clientId,
      delegator: "alice",
      workspace: typeof info.extra?.workspace === "string" ? info.extra.workspace : "",
      mayDraft: info.scopes.includes("folio:draft"),
    }),
  });
}

export function browserAgentContextFromRequest(request: Request): DemoContext {
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const requestUrl = new URL(request.url);
    const publicHost = request.headers.get("host") ?? requestUrl.host;
    const requestOrigin = `${requestUrl.protocol}//${publicHost}`;
    if (!origin || new URL(origin).origin !== requestOrigin) {
      throw new Error("same-origin browser request required");
    }
  }
  const context = tracedContext(
    // The browser route uses the signed-in demo session and never accepts an
    // agent identity from the browser payload.
    demoContextFromCookie(request.headers.get("cookie")),
    "webmcp",
  );
  return Object.freeze({
    ...context,
    delegation: Object.freeze({
      executor: "folio-webmcp-editor",
      delegator: context.session,
      workspace: "folio",
      mayDraft: context.canEdit,
    }),
  });
}

// Two surfaces, two Bindings. A credential that may only read is connected
// to a caller of the read Surface, where `saveDraft` does not exist; it is
// not shown the full surface with some tools filtered out. Narrowing is done
// where it is enforced.
const readMcpHandler = createMcpHandler({
  name: "folio",
  version: "1.0.0",
  caller: readCaller,
  context: ({ extra }) => {
    const info = extra.http?.authInfo;
    if (!info) throw new Error("verified MCP identity unavailable");
    return tracedContext(agentContextFromAuth(info), "mcp");
  },
  tools: [
    tool(readCaller, "get", { name: "getDocument" }),
    tool(readCaller, "publicationStatus", { name: "publicationStatus" }),
  ],
});

const draftMcpHandler = createMcpHandler({
  name: "folio",
  version: "1.0.0",
  caller,
  context: ({ extra }) => {
    const info = extra.http?.authInfo;
    if (!info) throw new Error("verified MCP identity unavailable");
    return tracedContext(agentContextFromAuth(info), "mcp");
  },
  tools: [
    tool(caller, "get", { name: "getDocument" }),
    tool(caller, "publicationStatus", { name: "publicationStatus" }),
    tool(caller, "save", { name: "saveDraft", scopeChallenge: requireScopes("folio:draft") }),
    // This is request-only. It creates a proposal and never exposes Control
    // administration or publication approval.
    tool(caller, "publish", { mode: "propose", name: "requestPublish", scopeChallenge: requireScopes("folio:draft") }),
  ],
});

/** Authentication belongs to the host, before selecting a narrower Binding. */
export function createFolioMcpEntry(verifier: OAuthTokenVerifier, resource: URL) {
  const authenticate = requireBearerAuth({ verifier, expectedResource: resource, requiredScopes: ["folio:read"] });
  return {
    async fetch(request: Request): Promise<Response> {
      const info = await authenticate(request);
      if (info instanceof Response) return info;
      const handler = info.scopes.includes("folio:draft") ? draftMcpHandler : readMcpHandler;
      return handler.fetch(request, { authInfo: info });
    },
    async close() { await Promise.all([readMcpHandler.close(), draftMcpHandler.close()]); },
  };
}
const resource = new URL(process.env.BOUNDARY_FOLIO_MCP_RESOURCE ?? "http://localhost:3000/api/mcp");
export const folioMcpHandler = createFolioMcpEntry(localTokenVerifier(resource), resource);

export const agentBoundaryHandler = createProtocolHandler({
  caller,
  path: "/api/agent-boundary",
  context: (request) => browserAgentContextFromRequest(request),
});
