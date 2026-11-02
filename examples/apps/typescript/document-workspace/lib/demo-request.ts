import { demoContextFromCookie } from "./context";

export function requestContext(request: Request) {
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (!origin || new URL(origin).host !== host) throw new Error("same-origin request required");
  }
  return demoContextFromCookie(request.headers.get("cookie"));
}

export async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("request body required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_000) { await reader.cancel(); throw new Error("request too large"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
