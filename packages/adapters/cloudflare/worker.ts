import type { HttpHandler } from "@foxworth/boundary/http";

export type WorkerFetch<Environment = unknown, Execution = unknown> = (
  request: Request,
  environment: Environment,
  execution: Execution,
) => Response | Promise<Response>;

/** The platform values available while processing one matched Worker request. */
export type SurfaceWorkerInvocation<Environment = unknown, Execution = unknown> =
  Readonly<{
    request: Request;
    environment: Environment;
    execution: Execution;
  }>;

/**
 * Creates the already-checked surface HTTP handler for one Worker request.
 *
 * Keep reusable bindings outside this factory. The application derives
 * invocation-scoped authentication and host context here; environment or a
 * service binding alone is not end-user authority.
 */
export type SurfaceWorkerHandlerFactory<
  Environment = unknown,
  Execution = unknown,
> = (
  invocation: SurfaceWorkerInvocation<Environment, Execution>,
) => HttpHandler | Promise<HttpHandler>;

export type SurfaceWorkerOptions<Environment = unknown, Execution = unknown> = {
  /** Optional framework mount path(s). Omit to send every request to the surface handler. */
  readonly mount?: string | readonly string[];
  /** Called for requests outside `mount`; defaults to a plain 404. */
  readonly fallback?: WorkerFetch<Environment, Execution>;
};

function mountPaths(
  value: SurfaceWorkerOptions["mount"],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const paths = typeof value === "string" ? [value] : [...value];
  if (paths.length === 0) {
    throw new TypeError(
      "@foxworth/boundary/cloudflare: mount must include at least one path",
    );
  }
  for (const path of paths) {
    if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw new TypeError(
        `@foxworth/boundary/cloudflare: invalid mount path: ${path}`,
      );
    }
  }
  return Object.freeze(paths);
}

function pathMatches(pathname: string, mount: string): boolean {
  return (
    mount === "/" ||
    pathname === mount ||
    pathname.startsWith(`${mount.replace(/\/$/, "")}/`)
  );
}

function internalError(): Response {
  return new Response("Internal Server Error", { status: 500 });
}

/** Adapt one explicit surface HTTP handler to a Workers module `fetch`. */
export function createSurfaceWorkerFetch<
  Environment = unknown,
  Execution = unknown,
>(
  handler: HttpHandler,
  options: SurfaceWorkerOptions<Environment, Execution> = {},
): WorkerFetch<Environment, Execution> {
  const mounts = mountPaths(options.mount);
  return async (request, environment, execution) => {
    const pathname = new URL(request.url).pathname;
    if (mounts && !mounts.some((mount) => pathMatches(pathname, mount))) {
      return (
        (await options.fallback?.(request, environment, execution)) ??
        new Response("Not Found", { status: 404 })
      );
    }
    try {
      return await handler(request);
    } catch {
      return internalError();
    }
  };
}

/**
 * Adapt a native Worker invocation factory to module `fetch`.
 *
 * Only matched requests create a surface handler. Fallback routing keeps
 * the application's request, environment, and execution context unchanged.
 */
export function createSurfaceWorkerFetchWithContext<
  Environment = unknown,
  Execution = unknown,
>(
  createHandler: SurfaceWorkerHandlerFactory<Environment, Execution>,
  options: SurfaceWorkerOptions<Environment, Execution> = {},
): WorkerFetch<Environment, Execution> {
  const mounts = mountPaths(options.mount);
  return async (request, environment, execution) => {
    const pathname = new URL(request.url).pathname;
    if (mounts && !mounts.some((mount) => pathMatches(pathname, mount))) {
      return (
        (await options.fallback?.(request, environment, execution)) ??
        new Response("Not Found", { status: 404 })
      );
    }
    try {
      const handler = await createHandler(
        Object.freeze({ request, environment, execution }),
      );
      return await handler(request);
    } catch {
      return internalError();
    }
  };
}
