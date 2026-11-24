import { createProjectionWorkerFetchWithContext } from "@foxworth/boundary/cloudflare";
import { createHttpHandler, route, type HttpHandler } from "@foxworth/boundary/http";
import { createProtocolHandler } from "@foxworth/boundary/http";
import {
  createTodoHost,
  type TodoCaller,
  type TodoHost,
} from "../../../../examples/apps/typescript/todo-multisurface/host";
import { createTodoStore } from "../../../../examples/apps/typescript/todo-multisurface/store";

type Tenant = "acme" | "other";
type Identity = Readonly<{ tenant: Tenant }>;
type TenantRecords = Readonly<{ get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }>;
type Environment = Readonly<{
  ASSETS: { fetch(request: Request): Promise<Response> };
  TODOS: TenantRecords;
}>;
type Execution = Readonly<{ waitUntil(promise: Promise<unknown>): void }>;

const sessions = new Map<string, Identity>([
  ["fixture-acme", { tenant: "acme" }],
  ["fixture-other", { tenant: "other" }],
]);

function authenticate(request: Request): Identity | undefined {
  const credential = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "");
  return credential === undefined ? undefined : sessions.get(credential);
}

function tenantFromPath(request: Request): Tenant | undefined {
  const match = /^\/boundary\/(acme|other)\/todos(?:\/|$)/u.exec(new URL(request.url).pathname);
  return match?.[1] as Tenant | undefined;
}

function opsRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/boundary\/(?:acme|other)/u, "/boundary");
  return new Request(url, request);
}

async function hostFor(records: TenantRecords, tenant: Tenant, hosts: Map<Tenant, Promise<TodoHost>>) {
  let host = hosts.get(tenant);
  if (!host) {
    host = (async () => {
      const stored = await records.get(`todos:${tenant}:v1`);
      const rows = stored === null
        ? [{ id: 1, title: `${tenant} private todo`, completed: false }]
        : JSON.parse(stored) as readonly { id: number; title: string; completed: boolean }[];
      return createTodoHost(createTodoStore(rows));
    })();
    hosts.set(tenant, host);
  }
  return host;
}

function caller(identity: Identity | undefined, requestedTenant: Tenant | undefined): TodoCaller {
  return identity !== undefined && identity.tenant === requestedTenant
    ? { kind: "screen", actorId: identity.tenant }
    : { kind: "agent", actorId: "unauthenticated" };
}

/** The Worker owns authentication, KV records, and routing. */
export async function createWorkerNativeFetch() {
  const hosts = new Map<Tenant, Promise<TodoHost>>();
  const nativeHandler = async (request: Request, environment: Environment, execution: Execution): Promise<HttpHandler> => {
    const identity = authenticate(request);
    const requestedTenant = tenantFromPath(request);
    const tenant = identity?.tenant ?? requestedTenant ?? "acme";
    const host = await hostFor(environment.TODOS, tenant, hosts);
    const routes = request.method === "POST"
      ? [route(host.screen.handles.create, { method: "POST", path: "/boundary/todos" })]
      : [route(host.screen.handles.list, { method: "GET", path: "/boundary/todos" })];
    const handler = createHttpHandler({
      binding: host.screenBinding,
      context: () => ({ ...caller(identity, requestedTenant), native: { environment, execution } }),
      routes,
    });
    return async (current) => {
      const response = await handler(opsRequest(current));
      if (response.ok && current.method === "POST") {
        await environment.TODOS.put(`todos:${tenant}:v1`, JSON.stringify(host.store.list()));
      }
      return response;
    };
  };
  const http = createProjectionWorkerFetchWithContext<Environment, Execution>(
    ({ request, environment, execution }) => nativeHandler(request, environment, execution),
    { mount: "/boundary", fallback: (request, environment) => environment.ASSETS.fetch(request) },
  );

  return async (request: Request, environment: Environment, execution: Execution) => {
    if (new URL(request.url).pathname.startsWith("/handoff/")) {
      const identity = authenticate(request);
      const tenant = identity?.tenant ?? "acme";
      const host = await hostFor(environment.TODOS, tenant, hosts);
      return createProtocolHandler({
        binding: host.screenBinding,
        context: () => ({ ...caller(identity, identity?.tenant), native: { environment, execution } }),
        path: "/handoff",
      })(request);
    }
    return http(request, environment, execution);
  };
}

export default { fetch: await createWorkerNativeFetch() };
