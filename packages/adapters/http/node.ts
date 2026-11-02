import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type NodeHttpIncoming = IncomingMessage & {
  originalUrl?: string;
};

function abortSignalFrom(req: IncomingMessage): AbortSignal | undefined {
  const controller = new AbortController();
  const onClose = () => {
    if (!req.complete) controller.abort();
  };
  req.on("close", onClose);
  return controller.signal;
}

/**
 * Build a WinterCG Request from a Node IncomingMessage.
 * When `canonicalPathname` is set, it replaces the URL pathname (query kept).
 */
export function toFetchRequest(
  req: NodeHttpIncoming,
  options?: {
    base?: string;
    canonicalPathname?: string;
    origin?: string;
  },
): Request {
  const base = options?.base ?? "/";
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim() ??
    ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    req.headers.host ??
    "localhost";

  let path = req.originalUrl ?? req.url ?? "/";
  if (base !== "/" && path.startsWith(base)) {
    path = `/${path.slice(base.length)}`.replace(/\/{2,}/g, "/");
  }
  const url = new URL(path, options?.origin ?? `${proto}://${host}`);
  if (options?.canonicalPathname) {
    url.pathname = options.canonicalPathname;
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers: req.headers as HeadersInit,
    body: hasBody
      ? (Readable.toWeb(req) as ReadableStream)
      : undefined,
    duplex: hasBody ? "half" : undefined,
    signal: abortSignalFrom(req),
  } as RequestInit);
}

function endIfOpen(res: ServerResponse): void {
  if (!res.writableEnded) res.end();
}

/** Stream a Fetch Response onto a Node ServerResponse. */
export async function sendFetchResponse(
  res: ServerResponse,
  response: Response,
  method = "GET",
): Promise<void> {
  if (res.headersSent) {
    endIfOpen(res);
    return;
  }

  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;

  res.writeHead(response.status, headers);

  const isHead = method === "HEAD";
  if (
    isHead ||
    !response.body ||
    response.status === 204 ||
    response.status === 304
  ) {
    endIfOpen(res);
    return;
  }

  try {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } catch {
    endIfOpen(res);
  }
}
