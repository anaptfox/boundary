import { createHttpHandler, route } from "@foxworth/boundary/http";
import { createSurfaceWorkerFetchWithContext } from "@foxworth/boundary/cloudflare";
import { describe, expect, it, vi } from "vitest";
import { createAdapterFixture } from "./helpers/adapter";
import { createWorkerNativeFetch } from "../fixtures/runtimes/cloudflare-worker/worker";

describe("@foxworth/boundary/cloudflare native Worker context", () => {
  it("keeps authenticated tenant records in application KV and rejects possession-only service callers", async () => {
    const values = new Map<string, string>();
    const environment = {
      ASSETS: { fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`) },
      TODOS: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => { values.set(key, value); },
      },
    };
    const execution = { waitUntil() {} };
    const fetch = await createWorkerNativeFetch();
    const headers = (tenant: "acme" | "other") => ({ authorization: `Bearer fixture-${tenant}` });
    const [created, forged, acme, other, fallback] = await Promise.all([
      fetch(new Request("https://example.test/boundary/acme/todos", {
        method: "POST", headers: { ...headers("acme"), "content-type": "application/json" }, body: JSON.stringify({ title: "acme persisted" }),
      }), environment, execution),
      fetch(new Request("https://example.test/boundary/acme/todos", {
        method: "POST", headers: { ...headers("other"), "content-type": "application/json" }, body: JSON.stringify({ title: "forged other write" }),
      }), environment, execution),
      fetch(new Request("https://example.test/boundary/acme/todos", { headers: headers("acme") }), environment, execution),
      fetch(new Request("https://example.test/boundary/other/todos", { headers: headers("other") }), environment, execution),
      fetch(new Request("https://example.test/app.js"), environment, execution),
    ]);
    expect(created.status).toBe(200);
    expect(forged.status).toBe(403);
    expect(values.get("todos:acme:v1")).toContain("acme persisted");
    await expect(acme.json()).resolves.toMatchObject({ result: { value: expect.arrayContaining([
      expect.objectContaining({ title: "acme private todo" }),
    ]) } });
    await expect(other.json()).resolves.toMatchObject({ result: { value: [{ id: 1, title: "other private todo", completed: false }] } });
    await expect(fallback.text()).resolves.toBe("asset:/app.js");
  });

  it("uses request, environment, and execution for matched invocations without sharing them", async () => {
    const fixture = await createAdapterFixture();
    const { caller } = await fixture.connect({ call: ["list"] });
    const createHandler = vi.fn(({ request, environment, execution }) => {
      const tenant = request.headers.get("x-tenant");
      const marker = { tenant, environment, execution };
      const role: "owner" | "viewer" =
        request.headers.get("x-role") === "owner" ? "owner" : "viewer";
      return createHttpHandler({
        caller,
        context: () => ({
          role,
          marker,
        }),
        routes: [route(caller, "list", { method: "GET", path: "/boundary/todos" })],
      });
    });
    const fallback = vi.fn(async (request: Request, environment: { assets: string }, execution: { trace: string }) =>
      new Response(`${new URL(request.url).pathname}:${environment.assets}:${execution.trace}`, {
        headers: { "x-fallback": "application" },
      }));
    const fetch = createSurfaceWorkerFetchWithContext(createHandler, {
      mount: "/boundary",
      fallback,
    });

    const [allowed, denied, asset] = await Promise.all([
      fetch(new Request("https://example.test/boundary/todos", { headers: { "x-role": "owner", "x-tenant": "acme" } }), { assets: "a" }, { trace: "one" }),
      fetch(new Request("https://example.test/boundary/todos", { headers: { "x-role": "viewer", "x-tenant": "other" } }), { assets: "b" }, { trace: "two" }),
      fetch(new Request("https://example.test/app.js"), { assets: "static" }, { trace: "three" }),
    ]);

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    await expect(asset.text()).resolves.toBe("/app.js:static:three");
    expect(asset.headers.get("x-fallback")).toBe("application");
    expect(createHandler).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledOnce();
    expect(createHandler.mock.calls.map(([value]) => value.request.headers.get("x-tenant"))).toEqual(["acme", "other"]);
    expect(fixture.contexts).toHaveLength(1);
  });
});
