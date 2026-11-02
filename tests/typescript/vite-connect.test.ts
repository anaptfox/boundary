import { describe, expect, it, vi } from "vitest";
import { mountProjection, mountProjectionLifecycle } from "@foxworth/boundary/frameworks/vite";

describe("@foxworth/boundary/frameworks/vite", () => {
  it("mounts one injected handler at explicit Connect paths", () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const plugin = mountProjection({
      handler,
      mount: ["/todos", "/openapi.json"],
    });
    const mounted: string[] = [];
    const use = vi.fn((path: string) => mounted.push(path));
    const configure = plugin.configureServer;

    expect(typeof configure).toBe("function");
    (configure as (server: unknown) => void)({ middlewares: { use } });

    expect(mounted).toEqual(["/todos", "/openapi.json"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects implicit or malformed mount declarations", () => {
    const handler = async () => new Response(null, { status: 204 });
    expect(() => mountProjection({ handler, mount: [] })).toThrow(/at least one/);
    expect(() => mountProjection({ handler, mount: "todos" })).toThrow(/start with/);
    expect(() => mountProjection({ handler, mount: "/todos?all" })).toThrow(
      /query\/hash/,
    );
  });

  it("normalizes explicit watch files and ignores unrelated hot updates", async () => {
    let entries = 0;
    const plugin = mountProjectionLifecycle({
      mount: "/_boundary",
      watch: "src/serving.mjs",
      entry: () => ({
        generation: `g${++entries}`,
        handler: async () => new Response("ok"),
      }),
    });
    const use = vi.fn();
    const add = vi.fn();
    const on = vi.fn();
    const server = {
      config: { root: "/workspace/app" },
      middlewares: { use },
      watcher: { add, on },
      httpServer: undefined,
    };

    const configureServer = plugin.configureServer;
    if (typeof configureServer !== "function") throw new Error("lifecycle plugin did not expose configureServer");
    // This is a deliberately minimal hook fixture; the cast is after narrowing
    // the actual Vite hook and keeps the test focused on the seam it exercises.
    await configureServer.call(
      {} as ThisParameterType<typeof configureServer>,
      server as unknown as Parameters<typeof configureServer>[0],
    );
    expect(add).toHaveBeenCalledWith(["/workspace/app/src/serving.mjs"]);
    const handleHotUpdate = plugin.handleHotUpdate;
    if (typeof handleHotUpdate !== "function") throw new Error("lifecycle plugin did not expose handleHotUpdate");
    const unrelated = { file: "/workspace/app/index.html", modules: [] } as unknown as Parameters<typeof handleHotUpdate>[0];
    const watched = { file: "/workspace/app/src/serving.mjs", modules: [] } as unknown as Parameters<typeof handleHotUpdate>[0];
    await handleHotUpdate.call(
      {} as ThisParameterType<typeof handleHotUpdate>,
      unrelated,
    );
    expect(entries).toBe(1);
    await handleHotUpdate.call(
      {} as ThisParameterType<typeof handleHotUpdate>,
      watched,
    );
    expect(entries).toBe(2);
    await (plugin.closeBundle as () => Promise<void>)();
  });
});
