import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const client = new Client({ name: "modern-rust-consumer", version: "1" }, { versionNegotiation: { mode: "auto" } });
try {
  await client.connect(new StdioClientTransport({ command: resolve("target/debug/examples/protocol_fixture"), args: [], stderr: "inherit" }));
  assert.equal(client.getServerVersion()?.name, "boundary-wire-fixture");
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["probe"]);
  const result = await client.callTool({ name: "probe", arguments: {} });
  assert.equal(result.structuredContent.certainty, "unknown");
  assert.equal(result.isError, true);
  console.log("✓ modern MCP SDK ↔ native Rust stdio wire, unknown outcome preserved (synthetic fixture)");
} finally { await client.close(); }
