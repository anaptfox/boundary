import type { Connect, Plugin } from "vite";
import { isAbsolute, resolve, win32 } from "node:path";
import type { HttpHandler } from "@foxworth/boundary/http";
import { sendFetchResponse, toFetchRequest } from "@foxworth/boundary/http/node";
import {
  createSurfaceViteLifecycle,
  type SurfaceViteEntryContext,
  type SurfaceViteLifecycleOptions,
  type SurfaceViteMode,
} from "./vite-lifecycle";
export { createSurfaceViteLifecycle } from "./vite-lifecycle";
export type {
  SurfaceViteCandidate,
  SurfaceViteDiagnostic,
  SurfaceViteEntryContext,
  SurfaceViteLifecycleOptions,
  SurfaceViteMode,
  SurfaceViteStatus,
} from "./vite-lifecycle";

export type SurfaceViteOptions = {
  /** The HTTP projection created by `createHttpHandler`. */
  readonly handler: HttpHandler;
  /**
   * Connect mount paths owned by this plugin. A path may be an exact route or
   * a route prefix. Boundary never discovers these from the application.
   */
  readonly mount: string | readonly string[];
  /** Handle framework/transport failures. Domain failures belong to handler. */
  readonly onError?: (
    error: unknown,
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>;
};

export type SurfaceViteLifecyclePluginOptions = SurfaceViteLifecycleOptions &
  Pick<SurfaceViteOptions, "mount" | "onError"> &
  Readonly<{
    /** Explicit entry files Vite should include in its development watcher. */
    readonly watch?: string | readonly string[];
  }>;

function mountPaths(value: SurfaceViteOptions["mount"]): readonly string[] {
  const paths = typeof value === "string" ? [value] : [...value];
  if (paths.length === 0) {
    throw new TypeError(
      "@foxworth/boundary/frameworks/vite: mount must include at least one path",
    );
  }
  for (const path of paths) {
    if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw new TypeError(
        `@foxworth/boundary/frameworks/vite: mount path must start with / and omit query/hash: ${path}`,
      );
    }
  }
  return Object.freeze(paths);
}

function explicitWatchPaths(
  value: SurfaceViteLifecyclePluginOptions["watch"],
  root: string,
): readonly string[] {
  const paths = value === undefined ? [] : typeof value === "string" ? [value] : [...value];
  return Object.freeze(paths.map((path) =>
    isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(root, path),
  ));
}

function internalError(): Response {
  return new Response(JSON.stringify({ error: "Internal Server Error" }), {
    status: 500,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Connect middleware around one explicit CompiledSurface HTTP handler. */
export function createSurfaceMiddleware(
  handler: HttpHandler,
  options: Pick<SurfaceViteOptions, "onError"> = {},
): Connect.NextHandleFunction {
  return (incoming, outgoing) => {
    const request = toFetchRequest(incoming);
    void (async () => {
      try {
        const response = await handler(request);
        await sendFetchResponse(outgoing, response, incoming.method ?? "GET");
      } catch (error) {
        if (outgoing.headersSent) {
          if (!outgoing.writableEnded) outgoing.end();
          return;
        }
        let response: Response;
        try {
          response = (await options.onError?.(error, request)) ?? internalError();
        } catch {
          response = internalError();
        }
        try {
          await sendFetchResponse(outgoing, response, incoming.method ?? "GET");
        } catch {
          if (!outgoing.writableEnded) outgoing.end();
        }
      }
    })();
  };
}

/** Mount one injected CompiledSurface HTTP handler in Vite dev and preview. */
export function mountSurface(options: SurfaceViteOptions): Plugin {
  const paths = mountPaths(options.mount);
  const middleware = createSurfaceMiddleware(options.handler, options);
  const install = (server: Connect.Server) => {
    for (const path of paths) server.use(path, middleware);
  };

  return {
    name: "boundary-projection",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/** Mounts an explicit, generation-owned entry with Vite dev/preview lifecycle hooks. */
export function mountSurfaceLifecycle(
  options: SurfaceViteLifecyclePluginOptions,
): Plugin {
  const paths = mountPaths(options.mount);
  const lifecycle = createSurfaceViteLifecycle(options);
  const middleware = createSurfaceMiddleware(
    (request) => lifecycle.dispatch(request),
    options,
  );
  const install = (server: Connect.Server) => {
    for (const path of paths) server.use(path, middleware);
  };
  const start = (mode: SurfaceViteMode, loadModule?: SurfaceViteEntryContext["loadModule"]) => lifecycle.start(mode, loadModule);
  let watchPaths: readonly string[] = [];
  let loadModule: SurfaceViteEntryContext["loadModule"];
  return {
    name: "boundary-projection-lifecycle",
    async configureServer(server) {
      install(server.middlewares);
      watchPaths = explicitWatchPaths(options.watch, server.config.root);
      if (watchPaths.length > 0) server.watcher.add(watchPaths);
      server.httpServer?.once("close", () => {
        void lifecycle.dispose();
      });
      server.watcher.on("close", () => {
        void lifecycle.dispose();
      });
      loadModule = typeof server.ssrLoadModule === "function" ? server.ssrLoadModule.bind(server) : undefined;
      await start("development", loadModule);
    },
    async configurePreviewServer(server) {
      install(server.middlewares);
      server.httpServer?.once("close", () => {
        void lifecycle.dispose();
      });
      await start("preview");
    },
    async handleHotUpdate(context) {
      if (watchPaths.length === 0 || !watchPaths.includes(context.file)) {
        return context.modules;
      }
      await lifecycle.replace("development", loadModule);
      return context.modules;
    },
    async closeBundle() {
      await lifecycle.dispose();
    },
  };
}
