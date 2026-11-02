import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { Window } from "happy-dom";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function rpc(base, token, method, params) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "folio-native-proof", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }),
  });
  const text = await response.text();
  const json = JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((line) => line.startsWith("data: ")).slice(6)
      : text,
  );
  assert(response.ok && !json.error, `MCP ${method} failed: ${text}`);
  return json.result;
}
export async function publicationUiSmoke(base, createHandoffInvocation) {
  const alice = { cookie: "boundary_demo_session=alice" };
  const manifest =
    await (await fetch(`${base}/api/boundary/manifest`, { headers: alice })).json();
  async function invoke(
    interaction,
    mode,
    input,
    headers = alice,
    path = "/api/boundary",
  ) {
    const active = path === "/api/boundary"
      ? manifest
      : await (await fetch(`${base}${path}/manifest`, { headers })).json();
    return (await fetch(`${base}${path}/invoke`, {
      method: "POST",
      headers: { ...headers, origin: base, "content-type": "application/json" },
      body: JSON.stringify(
        await createHandoffInvocation(active, interaction, mode, input),
      ),
    })).json();
  }
  const current =
    (await invoke("documents.get", "direct", { id: "doc-1" })).result.value;
  const selected = (await rpc(base, "folio-local-draft", "tools/list", {}))
    .tools.map((tool) => tool.name);
  assert(
    selected.includes("requestPublish") &&
      !selected.some((name) => /approve|execute|grant/i.test(name)),
    "MCP exposed publication administration",
  );
  const result = await rpc(base, "folio-local-draft", "tools/call", {
    name: "requestPublish",
    arguments: { id: "doc-1", expectedRevision: current.revision },
  });
  const outcome = result.structuredContent;
  assert(
    outcome.result.kind === "proposed",
    "External MCP did not request a real publication proposal",
  );
  const status =
    (await invoke("documents.publicationStatus", "direct", { id: "doc-1" }))
      .result.value;
  assert(
    status.published === null && status.proposals.length === 1,
    "Proposal creation published an effect",
  );
  const proposal = status.proposals[0];
  assert(
    proposal.requestedBy === "folio-editor:for:alice",
    "MCP delegation was not host-derived",
  );
  const browserRead = await invoke(
    "documents.get",
    "direct",
    { id: "doc-1" },
    alice,
    "/api/agent-boundary",
  );
  assert(
    browserRead.result?.value?.revision === current.revision,
    `Browser agent sees different saved state: ${JSON.stringify(browserRead)}`,
  );
  const browserDenied = await fetch(`${base}/api/agent-boundary/invoke`, {
    method: "POST",
    headers: {
      ...alice,
      origin: "https://foreign.invalid",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert(
    browserDenied.status === 403,
    "Cross-origin browser agent write was not rejected",
  );
  const html = await (await fetch(base, { headers: alice })).text();
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    const form = [...window.document.querySelectorAll("form")].find((form) =>
      form.querySelector('input[name="proposal"]')?.value === proposal.id
    );
    assert(form, "Human publication review did not render");
    const data = new FormData();
    for (const input of form.querySelectorAll("input")) {
      if (input.name) data.append(input.name, input.value);
    }
    data.set("mode", "approve");
    const denied = await fetch(base, {
      method: "POST",
      headers: { cookie: "boundary_demo_session=bob", origin: base },
      body: data,
    });
    assert(denied.ok, "Bob review rejection did not render");
    assert(
      (await invoke("documents.publicationStatus", "direct", { id: "doc-1" }))
        .result.value.published === null,
      "Bob approved publication",
    );
    const approved = await fetch(base, {
      method: "POST",
      headers: { ...alice, origin: base },
      body: data,
    });
    assert(approved.ok, "Human publication action failed");
    const published =
      (await invoke("documents.publicationStatus", "direct", { id: "doc-1" }))
        .result.value;
    assert(
      published.proposals[0].state === "completed" &&
        published.published.revision === current.revision &&
        published.published.body === current.body,
      "Exact reviewed revision did not publish",
    );
    assert(
      JSON.stringify(published).includes("lease") === false,
      "Public status leaked executor lease authority",
    );
    await fetch(base, {
      method: "POST",
      headers: { ...alice, origin: base },
      body: data,
    });
    const duplicate =
      (await invoke("documents.publicationStatus", "direct", { id: "doc-1" }))
        .result.value;
    assert(
      JSON.stringify(duplicate) === JSON.stringify(published),
      "Duplicate human review changed the publication",
    );
  } finally {
    window.close();
  }
  console.log(
    "✓ Next MCP → exact human publication review → browser/public status",
  );
}
