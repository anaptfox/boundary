import { createServer } from "node:http";
import { once } from "node:events";
import { portableSchema, type InvocationObservation } from "@foxworth/boundary/program";
import { bindProjection, compileInteractions, defineInteraction, directRealizationIds,
  implementInteractions, installInteractions, projectAllDirect } from "@foxworth/boundary";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { createObservationHttpHandler } from "@foxworth/boundary/http/observations";
import { createCaller } from "@foxworth/boundary/pipeline";

type Tenant = "a" | "b";
type Context = { tenant: Tenant };
const tokens = new Map<string, Tenant>();
for (const tenant of ["a", "b"] as const) {
  const token = process.env[`OBS_${tenant.toUpperCase()}_TOKEN`];
  if (!token) throw new Error("Host requires explicit tenant credentials");
  tokens.set(`Bearer ${token}`, tenant);
}
const state = { a: { value: 0, writes: 0 }, b: { value: 0, writes: 0 } };
const subscribers = new Map<Tenant, Set<(event: InvocationObservation) => void>>([
  ["a", new Set()], ["b", new Set()],
]);
const definitions = {
  read: defineInteraction({ id: "counter.read", output: portableSchema<number>({ type: "number" }), reads: ["counter"], changes: [] }),
  increment: defineInteraction({ id: "counter.increment", input: portableSchema<{ uncertain: boolean }>({
    type: "object", required: ["uncertain"], additionalProperties: false,
    properties: { uncertain: { type: "boolean" } },
  }), output: portableSchema<number>({ type: "number" }), reads: ["counter"], changes: ["counter"] }),
};
const compiled = await compileInteractions(definitions);
const projection = await projectAllDirect(compiled);
const implementations = implementInteractions<typeof definitions, Context>(definitions, {
  read: (context) => state[context.tenant].value,
  increment: (input, context) => {
    const counter = state[context.tenant];
    counter.value++; counter.writes++;
    // Demonstrate an applied effect followed by an unavailable result.
    if (input.uncertain) throw new Error("response unavailable after effect");
    return counter.value;
  },
});
const observation = {
  correlate: (context: Context) => ({ tenant: context.tenant }),
  publish(event: InvocationObservation) {
    const correlation = event.correlation as { tenant?: Tenant } | undefined;
    const tenant = correlation?.tenant;
    if (tenant !== "a" && tenant !== "b") return;
    // Routing evidence stays on the host; callers receive no tenant correlation.
    const { correlation: _private, ...redacted } = event;
    for (const publish of subscribers.get(tenant)!) publish(redacted);
  },
};
async function protocol(path: string, installationId: string) {
  const { installation } = await installInteractions(compiled, {
    installationId, implementations, realizationIds: directRealizationIds(compiled, "v1"),
  });
  const result = await bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }), observation,
  });
  if (result.status !== "bound") throw new Error("example could not bind");
  return createProtocolHandler({ caller: createCaller(result.binding), path, context: (request) => ({ tenant: authenticate(request)! }) });
}
function authenticate(request: Request): Tenant | undefined {
  return tokens.get(request.headers.get("authorization") ?? "");
}
const primary = await protocol("/boundary", "observation:primary");
// A second installation sharing application data proves identity-scoped refresh.
const other = await protocol("/other", "observation:other");
const events = createObservationHttpHandler<Context>({
  path: "/events",
  context(request) {
    const tenant = authenticate(request);
    return tenant ? { tenant } : new Response("Unauthorized", { status: 401 });
  },
  subscribe(context, publish) {
    const listeners = subscribers.get(context.tenant)!;
    listeners.add(publish);
    return () => { listeners.delete(publish); };
  },
});
const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.once("close", () => abort.abort());
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = incoming.method ?? "GET";
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method, headers, signal: abort.signal,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
    });
    const tenant = authenticate(request);
    let response: Response;
    if (!tenant) response = new Response("Unauthorized", { status: 401 });
    else if (new URL(request.url).pathname === "/diagnostics") {
      response = Response.json({ ...state[tenant], subscribers: subscribers.get(tenant)!.size });
    } else response = await events(request) ?? await (new URL(request.url).pathname.startsWith("/other") ? other(request) : primary(request));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.flushHeaders();
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!outgoing.write(next.value)) await once(outgoing, "drain");
      }
    }
    outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("missing listener address");
process.stdout.write(`${JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` })}\n`);
process.once("SIGTERM", () => { server.closeAllConnections(); server.close(); });
