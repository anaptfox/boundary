import { createHttpHandler, route } from "@foxworth/boundary/http";
import { createSurfaceHonoMiddleware } from "@foxworth/boundary/frameworks/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAdapterFixture } from "./helpers/adapter";
import { createHonoNativeApp } from "../fixtures/runtimes/hono/app";

type HonoEnvironment = {
  Bindings: { readonly deployment: string };
  Variables: { readonly role: "owner" | "viewer"; readonly marker: object };
};

describe("@foxworth/boundary/frameworks/hono native context", () => {
  it("keeps authenticated tenant records separate across concurrent typed read and mutation routes", async () => {
    const app = await createHonoNativeApp();
    const headers = (tenant: "acme" | "other") => ({ authorization: `Bearer hono-${tenant}` });
    const [created, denied, acme, other, health, missing] = await Promise.all([
      app.request("https://example.test/boundary/acme/todos", {
        method: "POST",
        headers: { ...headers("acme"), "content-type": "application/json" },
        body: JSON.stringify({ title: "acme only" }),
      }),
      app.request("https://example.test/boundary/acme/todos", {
        method: "POST",
        headers: { ...headers("other"), "content-type": "application/json" },
        body: JSON.stringify({ title: "forged other write" }),
      }),
      app.request("https://example.test/boundary/acme/todos", { headers: headers("acme") }),
      app.request("https://example.test/boundary/other/todos", { headers: headers("other") }),
      app.request("https://example.test/health"),
      app.request("https://example.test/not-boundary"),
    ]);

    expect(created.status).toBe(200);
    expect(denied.status).toBe(403);
    await expect(acme.json()).resolves.toMatchObject({ result: { value: expect.arrayContaining([
      expect.objectContaining({ title: "acme private todo" }),
    ]) } });
    await expect(other.json()).resolves.toMatchObject({ result: { value: [{ id: 1, title: "other private todo", completed: false }] } });
    const completed = await app.request("https://example.test/boundary/acme/todos/1/complete", {
      method: "POST", headers: headers("acme"), body: JSON.stringify({}),
    });
    await expect(completed.json()).resolves.toMatchObject({ result: {
      value: { id: 1, title: "acme private todo", completed: true },
    } });
    await expect(health.text()).resolves.toBe("ok");
    expect(missing.status).toBe(404);
  });

  it("derives checked invocation context from overlapping middleware-scoped requests", async () => {
    const fixture = await createAdapterFixture();
    const { caller } = await fixture.connect({ call: ["list"] });
    const seen: Array<Readonly<{ tenant: string | undefined; deployment: string }>> = [];
    const app = new Hono<HonoEnvironment>();

    app.use("/boundary/*", async (context, next) => {
      context.set("role", context.req.header("x-role") === "owner" ? "owner" : "viewer");
      context.set("marker", {});
      await next();
      context.header("x-hono-after", "preserved");
    });
    app.get(
      "/boundary/todos",
      createSurfaceHonoMiddleware<HonoEnvironment, "/boundary/todos">((context) => {
        seen.push({
          tenant: context.req.header("x-tenant"),
          deployment: context.env.deployment,
        });
        return createHttpHandler({
          caller,
          context: () => ({ role: context.var.role, marker: context.var.marker }),
          routes: [route(caller, "list", {
            method: "GET",
            path: "/boundary/todos",
            headers: { "x-boundary-projection": "selected" },
          })],
        });
      }),
    );
    app.get("/ordinary", (context) => context.text("ordinary"));

    const [allowed, denied, ordinary, notFound] = await Promise.all([
      app.request("https://example.test/boundary/todos", { headers: { "x-role": "owner", "x-tenant": "acme" } }, { deployment: "test" }),
      app.request("https://example.test/boundary/todos", { headers: { "x-role": "viewer", "x-tenant": "other" } }, { deployment: "test" }),
      app.request("https://example.test/ordinary", undefined, { deployment: "test" }),
      app.request("https://example.test/not-an-boundary-route", undefined, { deployment: "test" }),
    ]);

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(allowed.headers.get("x-hono-after")).toBe("preserved");
    expect(denied.headers.get("x-hono-after")).toBe("preserved");
    expect(allowed.headers.get("x-boundary-projection")).toBe("selected");
    expect(denied.headers.get("x-boundary-projection")).toBe("selected");
    await expect(ordinary.text()).resolves.toBe("ordinary");
    expect(notFound.status).toBe(404);
    expect(seen).toEqual([
      { tenant: "acme", deployment: "test" },
      { tenant: "other", deployment: "test" },
    ]);
    expect(fixture.contexts).toHaveLength(1);
  });

  it("keeps typed route parameters, variables, bindings, and execution context available to the host factory", async () => {
    const app = new Hono<HonoEnvironment>();
    app.use("/native/*", async (context, next) => {
      context.set("role", "owner");
      context.set("marker", {});
      await next();
    });
    app.get(
      "/native/:tenant",
      createSurfaceHonoMiddleware<HonoEnvironment, "/native/:tenant">((context) => {
        const tenant: string = context.req.param("tenant");
        const role: "owner" | "viewer" = context.var.role;
        const deployment: string = context.env.deployment;
        const execution = context.executionCtx;
        return async () => new Response(`${tenant}:${role}:${deployment}:${typeof execution.waitUntil}`);
      }),
    );

    const response = await app.request(
      "https://example.test/native/acme",
      undefined,
      { deployment: "edge" },
      { waitUntil() {}, passThroughOnException() {}, props: {} },
    );
    await expect(response.text()).resolves.toBe("acme:owner:edge:function");
  });
});
