import { describe, expect, it } from "vitest";
import { DpopSession } from "@modelcontextprotocol/client";
import { requireBearerAuth, requireScopes, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler, serveHost, tool } from "@foxworth/boundary/mcp";
import { createAdapterFixture } from "./helpers/adapter";
import { localTokenVerifier } from "../../examples/apps/typescript/document-workspace/lib/local-auth";
import { localDpopGate } from "../fixtures/auth/dpop";

const resource = new URL("https://folio.test/api/mcp");
const modern = (name: string) => new Request(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { title: "Scoped" }, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "qualification", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }) });

describe("modern MCP qualification", () => {
  it("rejects legacy requests without resolving context and forwards body limits", async () => {
    const fixture = await createAdapterFixture();
    const { caller } = await fixture.connect({ call: ["create"] });
    let contexts = 0;
    const server = serveHost({ doors: [], mcp: { path: "/api/mcp", name: "bounded", version: "1", caller, context: () => { contexts++; return { role: "owner" as const, marker: {} }; }, tools: [tool(caller, "create")], handlerOptions: { maxRequestBodySize: 256 } } });
    try {
      const response = await server.handler(new Request(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "old", version: "1" }, capabilities: {} } }) }));
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: -32022 } }); expect(contexts).toBe(0);
      const oversized = await server.handler(new Request(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "x".repeat(1000) }));
      expect(oversized.status).toBe(413);
    } finally { await server.dispose(); }
  });
  it("challenges missing scopes before host context or effect execution", async () => {
    const fixture = await createAdapterFixture();
    const { caller } = await fixture.connect({ call: ["create"] });
     let contexts = 0;
    const handler = createMcpHandler({ name: "scope", version: "1", caller, context: ({ extra }) => { contexts++; expect(extra.http?.authInfo?.clientId).toBe("folio-editor"); return { role: "owner" as const, marker: {} }; }, tools: [tool(caller, "create", { name: "create", scopeChallenge: requireScopes("folio:draft") })] }, { responseMode: "json" });
    const verifier = localTokenVerifier(resource);
    try {
      const denied = await handler.fetch(modern("create"), { authInfo: await verifier.verifyAccessToken("folio-local-read") });
      expect(denied.status).toBe(403); expect(denied.headers.get("www-authenticate")).toContain("folio:draft"); expect(contexts).toBe(0); expect(fixture.rows).toEqual([]);
      const allowed = await handler.fetch(modern("create"), { authInfo: await verifier.verifyAccessToken("folio-local-draft") });
      expect(allowed.status).toBe(200); expect(contexts).toBe(1); expect(fixture.rows).toHaveLength(1);
    } finally { await handler.close(); }
  });
  it("rejects wrong resource, expired credentials and insufficient scopes", async () => {
    const base = await localTokenVerifier(resource).verifyAccessToken("folio-local-read");
    for (const changed of [{ resource: new URL("https://other.test/mcp") }, { expiresAt: 1 }, { scopes: [] }]) {
      const gate = requireBearerAuth({ verifier: { async verifyAccessToken() { return { ...base, ...changed }; } }, expectedResource: resource, requiredScopes: ["folio:read"] });
      const result = await gate(new Request(resource, { headers: { authorization: "Bearer fixture" } }));
      expect(result).toBeInstanceOf(Response); expect((result as Response).status).toBe(changed.scopes ? 403 : 401);
    }
  });
  it("accepts a native client DPoP proof once and rejects wrong key, method and token", async () => {
    const session = await DpopSession.create();
    const gate = localDpopGate({ verifier: localTokenVerifier(resource), resource, tokenThumbprint: session.thumbprint });
    const token = "folio-local-read";
    const proof = await session.buildProof({ htm: "POST", htu: resource, accessToken: token });
    const request = () => new Request(resource, { method: "POST", headers: { authorization: `DPoP ${token}`, dpop: proof } });
    expect(await gate(request())).toMatchObject({ clientId: "folio-scout" });
    expect(await gate(request())).toMatchObject({ status: 401 });
    const other = await DpopSession.create();
    for (const invalid of [await other.buildProof({ htm: "POST", htu: resource, accessToken: token }), await session.buildProof({ htm: "GET", htu: resource, accessToken: token }), await session.buildProof({ htm: "POST", htu: resource, accessToken: "different" })]) {
      expect(await gate(new Request(resource, { method: "POST", headers: { authorization: `DPoP ${token}`, dpop: invalid } }))).toMatchObject({ status: 401 });
    }
  });
});
