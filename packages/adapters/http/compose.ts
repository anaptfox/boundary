import type { ProjectionBinding } from "@foxworth/boundary";
import { AdapterError } from "#remote";
import {
  createHttpHandler,
  type HttpHandler,
  type HttpRoute,
} from "./handler";
import { openapi } from "./openapi";
import { createProtocolHandler } from "./protocol";

export type CreateCompositeHttpHandlerOptions<Context> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  context(request: Request): Context | Promise<Context>;
  routes: readonly HttpRoute[];
  title: string;
  version: string;
  /** Host-owned mount for Program inspection and calls. */
  protocolPath: string;
}>;

/** One REST + browser-protocol + OpenAPI door. Applications keep their routes and title. */
export function createCompositeHttpHandler<Context>(
  options: CreateCompositeHttpHandlerOptions<Context>,
): HttpHandler {
  const protocolPath = normalizeOwnedPath(
    options.protocolPath,
    "createCompositeHttpHandler.protocolPath",
  );
  if (protocolPath === "/openapi.json") {
    throw new AdapterError(
      "DUPLICATE_DECLARATION",
      "createCompositeHttpHandler.protocolPath",
      "protocol path collides with /openapi.json",
    );
  }
  for (const [index, route] of options.routes.entries()) {
    if (routeCanMatchOwnedPrefix(route.path, protocolPath)) {
      throw new AdapterError(
        "DUPLICATE_DECLARATION",
        `routes[${index}].path`,
        `REST route collides with protocol path: ${protocolPath}`,
      );
    }
  }
  const rest = createHttpHandler({
    binding: options.binding,
    context: options.context,
    routes: options.routes,
  });
  const protocol = createProtocolHandler({
    binding: options.binding,
    context: options.context,
    path: protocolPath,
  });
  const openapiDocument = openapi({
    binding: options.binding,
    routes: options.routes,
    title: options.title,
    version: options.version,
  }).then((specification) => {
    const body = JSON.stringify(specification);
    const etag = `"${options.binding.manifest.bindingDigest}"`;
    return { body, etag };
  });

  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/openapi.json") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const { body, etag } = await openapiDocument;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag,
          "cache-control": "no-cache",
        },
      });
    }
    if (
      pathname === protocolPath ||
      pathname.startsWith(`${protocolPath}/`)
    ) {
      return protocol(request);
    }
    return rest(request);
  };
}

export type HttpMount = Readonly<{
  path: string;
  fetch(request: Request): Response | Promise<Response>;
}>;

function normalizeOwnedPath(path: string, label: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      label,
      "mount path must be an absolute pathname",
    );
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  if (normalized === "/") {
    throw new AdapterError(
      "INVALID_DECLARATION",
      label,
      "mount path must not claim the application root",
    );
  }
  return normalized;
}

function routeCanMatchOwnedPrefix(routePath: string, ownedPrefix: string): boolean {
  const routeSegments = routePath.split("/").filter(Boolean);
  const prefixSegments = ownedPrefix.split("/").filter(Boolean);
  if (routeSegments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => {
    const routeSegment = routeSegments[index]!;
    return routeSegment === segment || (
      routeSegment.startsWith("{") && routeSegment.endsWith("}")
    );
  });
}

/** Dispatch one handler across non-overlapping explicit path prefixes. */
export function mountHandlers(mounts: readonly HttpMount[]): {
  handler: HttpHandler;
  paths: readonly string[];
} {
  if (mounts.length === 0) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "mountHandlers",
      "at least one mount is required",
    );
  }
  const normalized = mounts.map((mount, index) => {
    const path = normalizeOwnedPath(mount.path, `mounts[${index}].path`);
    return { path, fetch: mount.fetch };
  });
  const paths = normalized.map((mount) => mount.path);
  if (new Set(paths).size !== paths.length) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "mountHandlers",
      "mount paths must be unique",
    );
  }
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const a = paths[left]!;
      const b = paths[right]!;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new AdapterError(
          "INVALID_DECLARATION",
          "mountHandlers",
          `mount paths must not overlap: ${a} and ${b}`,
        );
      }
    }
  }
  return {
    paths: Object.freeze([...paths]),
    handler: async (request) => {
      const pathname = new URL(request.url).pathname;
      for (const mount of normalized) {
        if (
          pathname === mount.path ||
          pathname.startsWith(`${mount.path}/`)
        ) {
          return mount.fetch(request);
        }
      }
      return new Response(null, { status: 404 });
    },
  };
}
