import type {
  AnyCaller,
  ProjectionBindingManifest,
} from "@foxworth/boundary";
import {
  createCheckedHandoff,
  HandoffError,
  validateHandoffInvocation,
  validateHandoffOutcome,
  type HandoffInvocation,
  type HandoffOutcome,
} from "@foxworth/boundary/handoff";
import { AdapterError, RemoteProtocolRejection, seamOf } from "@foxworth/boundary/remote";
import type { HttpHandler } from "./handler";
import { statusForRemoteResult } from "@foxworth/boundary/remote";

export type ProgramHandshake = ProjectionBindingManifest;

import type { ClientTransport, ClientInvokeFraming } from "@foxworth/boundary/client";

export type CreateProtocolHandlerOptions<Context> = Readonly<{
  caller: AnyCaller<Context>;
  context(request: Request): Context | Promise<Context>;
  path: string;
}>;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function protocolPath(path: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new AdapterError("INVALID_DECLARATION", "createProtocolHandler.path", "protocol path must be an absolute pathname");
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  if (normalized === "/") {
    throw new AdapterError("INVALID_DECLARATION", "createProtocolHandler.path", "protocol path must not claim the application root");
  }
  return normalized;
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    throw new AdapterError("INVALID_REQUEST", "request.body", "version 1 Handoff invocation is required");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdapterError("INVALID_REQUEST", "request.body", "request body must be valid JSON");
  }
}

function failure(error: unknown): Response {
  const known = error instanceof AdapterError || error instanceof HandoffError;
  const code = known ? String((error as { code: unknown }).code) : "REMOTE_EXECUTION_FAILED";
  const path = known ? String((error as { path: unknown }).path) : "protocol";
  const conflict = code.startsWith("STALE_") || code === "INTERACTION_NOT_EXPOSED" || code === "MODE_NOT_EXPOSED";
  const issues = error instanceof HandoffError ? error.issues : undefined;
  return json({
    error: {
      kind: known ? "protocol" : "internal",
      code,
      ...(known ? { path } : {}),
      ...(issues === undefined ? {} : { issues }),
      message: known
        ? "The version 1 Handoff invocation was rejected."
        : "The interaction could not be completed.",
    },
  }, known ? (conflict ? 409 : 400) : 500);
}

/** Opt-in version 1 Handoff protocol for one connected caller's Binding. */
export function createProtocolHandler<Context>(
  options: CreateProtocolHandlerOptions<Context>,
): HttpHandler {
  if (!options || typeof options.context !== "function") {
    throw new AdapterError("INVALID_DECLARATION", "createProtocolHandler.context", "context must resolve one invocation-scoped host value");
  }
  const base = protocolPath(options.path);
  const checked = createCheckedHandoff(seamOf(options.caller, "createProtocolHandler.caller"));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `${base}/manifest`) {
      try {
        const handoff = await checked;
        const etag = `"${handoff.manifest.bindingDigest}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return json(handoff.manifest, 200, { etag, "cache-control": "no-cache" });
      } catch (error) {
        return failure(error);
      }
    }
    if (request.method === "POST" && url.pathname === `${base}/invoke`) {
      try {
        const invocation = validateHandoffInvocation(await body(request));
        const handoff = await checked;
        const outcome = await handoff.invoke(invocation, await options.context(request));
        return json(outcome, statusForRemoteResult(outcome));
      } catch (error) {
        return failure(error);
      }
    }
    return json({
      error: {
        kind: "protocol",
        code: "ROUTE_NOT_FOUND",
        path: "request.url",
        message: "No version 1 protocol route matched.",
      },
    }, 404);
  };
}

export type FetchTransportOptions = Readonly<{
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}>;

async function responseJson(
  response: Response,
  path: string,
  acceptOutcome = false,
): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AdapterError("TRANSPORT_FAILURE", path, "transport returned invalid JSON");
  }
  if (!response.ok) {
    if (acceptOutcome) {
      try {
        return validateHandoffOutcome(value);
      } catch {
        // Fall through to the sanitized transport diagnostic below.
      }
    }
    const remote = value && typeof value === "object" && "error" in value
      ? (value as { error?: { kind?: unknown; code?: unknown; path?: unknown } }).error
      : undefined;
    if (
      acceptOutcome &&
      (response.status === 400 || response.status === 409) &&
      remote?.kind === "protocol" &&
      typeof remote.code === "string" &&
      typeof remote.path === "string"
    ) {
      throw new RemoteProtocolRejection(
        response.status,
        remote.code,
        remote.path,
      );
    }
    throw new AdapterError(
      response.status === 409 ? "STALE_BINDING" : "TRANSPORT_FAILURE",
      path,
      typeof remote?.code === "string" ? `remote rejected the request: ${remote.code}` : `transport returned HTTP ${response.status}`,
    );
  }
  return value;
}

/** Fetch transport for the exact two-endpoint version 1 protocol. */
export function fetchTransport(options: FetchTransportOptions): ClientTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new AdapterError("INVALID_DECLARATION", "fetchTransport.fetch", "fetch is unavailable");
  }
  const base = options.baseUrl.replace(/\/+$/u, "");
  if (!base) {
    throw new AdapterError("INVALID_DECLARATION", "fetchTransport.baseUrl", "baseUrl is required");
  }
  return Object.freeze({
    async inspect(): Promise<ProjectionBindingManifest> {
      const response = await fetcher(`${base}/manifest`, {
        method: "GET",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });
      return await responseJson(response, "transport.inspect") as ProjectionBindingManifest;
    },
    async invoke(
      invocation: HandoffInvocation,
      framing?: ClientInvokeFraming,
    ): Promise<HandoffOutcome> {
      const headers = new Headers(options.headers);
      if (framing?.headers) {
        new Headers(framing.headers).forEach((value, key) => {
          headers.set(key, value);
        });
      }
      headers.set("content-type", "application/json");
      const response = await fetcher(`${base}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify(invocation),
      });
      return await responseJson(
        response,
        "transport.invoke",
        true,
      ) as HandoffOutcome;
    },
  });
}
