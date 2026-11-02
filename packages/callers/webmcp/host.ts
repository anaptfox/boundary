import type { ModelContextPort } from "./types";

function documentModelContext(): ModelContextPort | undefined {
  const candidate = (globalThis as {
    document?: { modelContext?: ModelContextPort };
  }).document?.modelContext;
  if (candidate && typeof candidate.registerTool === "function") {
    return candidate;
  }
  return undefined;
}

/** True when the current document exposes the WebMCP imperative API. Never throws. */
export function isWebMcpAvailable(port?: ModelContextPort): boolean {
  const resolved = port ?? documentModelContext();
  return Boolean(resolved && typeof resolved.registerTool === "function");
}

export function resolveModelContext(
  port?: ModelContextPort,
): ModelContextPort | undefined {
  return port ?? documentModelContext();
}
