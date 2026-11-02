import type { HttpHandler } from "@foxworth/boundary/http";

export type SerializedFetchRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly [string, string][];
  readonly body: string | null;
};

export type SerializedFetchResponse = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
  readonly body: string | null;
};

function headersFrom(entries: readonly [string, string][]): Headers {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, value);
  return headers;
}

/** Resolve a renderer fetch input against the in-process projection origin. */
export function projectionRequest(
  input: RequestInfo | URL,
  origin: string,
  init?: RequestInit,
): Request {
  if (input instanceof Request) {
    return init === undefined ? input : new Request(input, init);
  }
  return new Request(new URL(String(input), origin), init);
}

export async function serializeFetchRequest(
  request: Request,
): Promise<SerializedFetchRequest> {
  return Object.freeze({
    url: request.url,
    method: request.method,
    headers: Object.freeze(
      [...request.headers.entries()] as [string, string][],
    ),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text(),
  });
}

export function deserializeFetchRequest(
  wire: SerializedFetchRequest,
): Request {
  const method = wire.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && wire.body !== null;
  return new Request(wire.url, {
    method,
    headers: headersFrom(wire.headers),
    ...(hasBody ? { body: wire.body } : {}),
  });
}

export async function serializeFetchResponse(
  response: Response,
): Promise<SerializedFetchResponse> {
  return Object.freeze({
    status: response.status,
    statusText: response.statusText,
    headers: Object.freeze(
      [...response.headers.entries()] as [string, string][],
    ),
    body: response.body === null ? null : await response.text(),
  });
}

export function deserializeFetchResponse(
  wire: SerializedFetchResponse,
): Response {
  return new Response(wire.body, {
    status: wire.status,
    statusText: wire.statusText,
    headers: headersFrom(wire.headers),
  });
}

export function internalError(): Response {
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Run one injected handler and never leak thrown values. */
export async function dispatchHandler(
  handler: HttpHandler,
  request: Request,
): Promise<Response> {
  try {
    return await handler(request);
  } catch {
    return internalError();
  }
}
