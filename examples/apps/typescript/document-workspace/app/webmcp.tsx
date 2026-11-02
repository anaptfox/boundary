"use client";

import { useEffect, useState } from "react";
import { createProjectionClient } from "@foxworth/boundary/client";
import { fetchTransport } from "@foxworth/boundary/http/protocol";
import { isWebMcpAvailable, registerWebMcpTransport, webMcpTool, type WebMcpRegistration } from "@foxworth/boundary/webmcp";

/** Optional browser entry point. The visible Folio UI remains complete without WebMCP. */
export function FolioWebMcp({ session }: { session: "alice" | "bob" }) {
  const [activity, setActivity] = useState("Browser tools unavailable");
  useEffect(() => {
    setActivity("Browser tools unavailable");
    let registration: WebMcpRegistration | undefined;
    let cancelled = false;
    if (!isWebMcpAvailable()) return;
    const client = createProjectionClient(fetchTransport({ baseUrl: "/api/agent-boundary" }));
    void (async () => {
      try {
        const manifest = await client.inspect();
        if (cancelled) return;
        registration = await registerWebMcpTransport({
          onActivity: ({ toolName, state }) => { if (!cancelled) setActivity(`${toolName}: ${state}`); },
          transport: fetchTransport({ baseUrl: "/api/agent-boundary" }),
          tools: [
            webMcpTool(manifest, "get", { name: "getDocument", untrustedContentHint: true }),
            webMcpTool(manifest, "publicationStatus", { name: "publicationStatus", untrustedContentHint: true }),
            ...(session === "alice" ? [
              webMcpTool(manifest, "save", { name: "saveDraft" }),
              webMcpTool(manifest, "publish", { mode: "propose", name: "requestPublish" }),
            ] : []),
          ],
        });
        if (!cancelled) setActivity("Browser tools ready");
        if (cancelled) {
          registration.dispose();
          registration = undefined;
        }
      } catch {
        // Browser support and registration are optional; visible controls remain.
      }
    })();
    return () => {
      cancelled = true;
      registration?.dispose();
    };
  }, [session]);
  return <span className="webmcp-activity" aria-live="polite">{activity}</span>;
}
