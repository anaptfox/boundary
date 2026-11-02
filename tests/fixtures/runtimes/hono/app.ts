import { Hono } from "hono";
import { createHttpHandler, route } from "@foxworth/boundary/http";
import { createProjectionHonoMiddleware } from "@foxworth/boundary/frameworks/hono";
import {
  createTodoHost,
  type TodoCaller,
  type TodoHost,
} from "../../../../examples/apps/typescript/todo-multisurface/host";
import { createTodoStore } from "../../../../examples/apps/typescript/todo-multisurface/store";

type Identity = Readonly<{ tenant: "acme" | "other" }>;
type AppEnvironment = { Variables: { readonly identity: Identity | undefined } };

const sessions = new Map<string, Identity>([
  ["hono-acme", { tenant: "acme" }],
  ["hono-other", { tenant: "other" }],
]);

function authenticate(authorization: string | undefined): Identity | undefined {
  const credential = authorization?.replace(/^Bearer\s+/u, "");
  return credential === undefined ? undefined : sessions.get(credential);
}

function initialRows(tenant: Identity["tenant"]) {
  return [{ id: 1, title: `${tenant} private todo`, completed: false }] as const;
}

function opsRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/boundary\/(?:acme|other)/u, "/boundary");
  return new Request(url, request);
}

/** The application owns authentication and tenant-specific records. */
export async function createHonoNativeApp() {
  const hosts = new Map<Identity["tenant"], Promise<TodoHost>>();
  const hostFor = (tenant: Identity["tenant"]) => {
    let host = hosts.get(tenant);
    if (!host) {
      host = createTodoHost(createTodoStore(initialRows(tenant)));
      hosts.set(tenant, host);
    }
    return host;
  };
  const app = new Hono<AppEnvironment>();
  app.use("/boundary/*", async (context, next) => {
    context.set("identity", authenticate(context.req.header("authorization")));
    await next();
  });

  const contextFor = (identity: Identity | undefined, requestedTenant: string): TodoCaller =>
    identity?.tenant === requestedTenant
      ? { kind: "screen", actorId: identity.tenant }
      : { kind: "agent", actorId: "unauthenticated" };

  // The route parameter and authenticated identity are both application data.
  // They narrow admission; neither creates a route/schema nor grants access.
  app.get("/boundary/:tenant/todos", createProjectionHonoMiddleware<AppEnvironment, "/boundary/:tenant/todos">(async (context) => {
    const identity = context.var.identity;
    const host = await hostFor(identity?.tenant ?? "acme");
    const handler = createHttpHandler({
      caller: host.screenCaller,
      context: () => contextFor(identity, context.req.param("tenant")),
      routes: [route(host.screenCaller, "list", { method: "GET", path: "/boundary/todos" })],
    });
    return (request) => handler(opsRequest(request));
  }));
  app.post("/boundary/:tenant/todos", createProjectionHonoMiddleware<AppEnvironment, "/boundary/:tenant/todos">(async (context) => {
    const identity = context.var.identity;
    const host = await hostFor(identity?.tenant ?? "acme");
    const handler = createHttpHandler({
      caller: host.screenCaller,
      context: () => contextFor(identity, context.req.param("tenant")),
      routes: [route(host.screenCaller, "create", { method: "POST", path: "/boundary/todos" })],
    });
    return (request) => handler(opsRequest(request));
  }));
  app.post("/boundary/:tenant/todos/:id/complete", createProjectionHonoMiddleware<AppEnvironment, "/boundary/:tenant/todos/:id/complete">(async (context) => {
    const identity = context.var.identity;
    const host = await hostFor(identity?.tenant ?? "acme");
    const handler = createHttpHandler({
      caller: host.screenCaller,
      context: () => contextFor(identity, context.req.param("tenant")),
      routes: [route(host.screenCaller, "complete", {
        method: "POST",
        path: "/boundary/todos/{id}/complete",
        input: () => ({ id: Number(context.req.param("id")) }),
      })],
    });
    return (request) => handler(opsRequest(request));
  }));
  app.get("/health", (context) => context.text("ok"));
  return app;
}
