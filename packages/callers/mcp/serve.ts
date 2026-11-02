import type { ProjectionBinding } from "@foxworth/boundary";
import { AdapterError } from "@foxworth/boundary/remote";
import { type HttpHandler } from "@foxworth/boundary/http";
import { mountHandlers } from "@foxworth/boundary/http/compose";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import {
  createMcpHandler,
  type CreateMcpServerOptions,
  type McpTool,
  type BoundaryMcpHttpOptions,
} from "./server";

export type ServeDoor<Context = unknown> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  context(request: Request): Context | Promise<Context>;
  path: string;
}>;

export type ServeHostMcp<Context = unknown> = Readonly<{
  path: string;
  name: string;
  version: string;
  binding: ProjectionBinding<any, Context>;
  context: CreateMcpServerOptions<Context>["context"];
  tools: readonly McpTool[];
  handlerOptions?: BoundaryMcpHttpOptions;
  maxToolInputElements?: CreateMcpServerOptions<Context>["maxToolInputElements"];
}>;

export type ServeHostOptions = Readonly<{
  doors: readonly ServeDoor<any>[];
  mcp?: ServeHostMcp<any>;
}>;

export type ServeHostResult = Readonly<{
  handler: HttpHandler;
  paths: readonly string[];
  dispose(): Promise<void>;
}>;

/** Compose protocol doors and an optional MCP mount into one handler. */
export function serveHost(options: ServeHostOptions): ServeHostResult {
  if (options.doors.length === 0 && options.mcp === undefined) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "serveHost",
      "serveHost requires at least one door or an MCP mount",
    );
  }
  const mcp = options.mcp
    ? createMcpHandler({
        name: options.mcp.name,
        version: options.mcp.version,
        binding: options.mcp.binding,
        context: options.mcp.context,
        tools: options.mcp.tools,
        maxToolInputElements: options.mcp.maxToolInputElements,
      }, options.mcp.handlerOptions)
    : undefined;
  const mounts = [
    ...options.doors.map((door) => ({
      path: door.path,
      fetch: createProtocolHandler({
        binding: door.binding,
        context: door.context,
        path: door.path,
      }),
    })),
    ...(mcp && options.mcp
      ? [{ path: options.mcp.path, fetch: (request: Request) => mcp.fetch(request) }]
      : []),
  ];
  const { handler, paths } = mountHandlers(mounts);
  return {
    handler,
    paths,
    async dispose() {
      await mcp?.close();
    },
  };
}
