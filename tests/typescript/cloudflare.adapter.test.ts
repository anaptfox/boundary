import {
  createSurfaceDurableObject,
  createSurfaceWorkerFetch,
} from "@foxworth/boundary/cloudflare";
import { describe, expect, it, vi } from "vitest";

describe("@foxworth/boundary/cloudflare", () => {
  it("routes only explicit worker mount paths", async () => {
    const handler = vi.fn(async (request: Request) =>
      new Response(new URL(request.url).pathname),
    );
    const fallback = vi.fn(async () => new Response("asset"));
    const fetch = createSurfaceWorkerFetch(handler, {
      mount: "/api",
      fallback,
    });

    await expect(
      (await fetch(new Request("https://example.test/api/todos"), {}, {})).text(),
    ).resolves.toBe("/api/todos");
    await expect(
      (await fetch(new Request("https://example.test/app.js"), {}, {})).text(),
    ).resolves.toBe("asset");
    expect(handler).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("creates one handler per Durable Object instance", async () => {
    const createHandler = vi.fn((state: { name: string }) =>
      async () => new Response(state.name),
    );
    const DurableObject = createSurfaceDurableObject(createHandler);
    const first = new DurableObject({ name: "first" }, {});
    const second = new DurableObject({ name: "second" }, {});

    await expect(
      (await first.fetch(new Request("https://example.test/todos"))).text(),
    ).resolves.toBe("first");
    await expect(
      (await second.fetch(new Request("https://example.test/todos"))).text(),
    ).resolves.toBe("second");
    expect(createHandler).toHaveBeenCalledTimes(2);
  });

  it("does not expose thrown handler errors", async () => {
    const fetch = createSurfaceWorkerFetch(async () => {
      throw new Error("private details");
    });
    const response = await fetch(new Request("https://example.test/api"), {}, {});

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
