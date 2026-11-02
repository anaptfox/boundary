import { PersistentBotApp, type BotOptions } from "./app";
import { serve } from "./runtime.ts";
import { page } from "./page";

const notices: Record<string, string> = {
  accepted: "Delegation saved. Planner will continue in the host. Refresh to see progress.",
  interrupted: "Stopped before an effect started.",
  settling: "The interaction already started. Its outcome will settle; interruption cannot undo it.",
  unchanged: "No state changed. Completed and uncertain work was not cancelled.",
  completed: "The existing exact draft was found and reconciled.",
  "not-applied": "No saved draft was found. The interaction was not retried.",
  uncertain: "The observed draft differs. The effect remains uncertain.",
};

export async function startServer(options: {
  database: string;
  port?: number;
  /** Explicit opt-in for native localhost clients with neither Origin nor Fetch Metadata. */
  allowOriginlessCli?: boolean;
  bot?: BotOptions;
}) {
  let stop: (() => Promise<void>) | undefined;
  const app = new PersistentBotApp(options.database, {
    ...options.bot,
    onFatal(error) {
      console.error("Persistent bot could not persist status; host is stopping.", error);
      void stop?.();
    },
  });
  let origin = "";
  let server: ReturnType<typeof serve>;
  const reply = (body: BodyInit | null, status: number, extra: Record<string, string> = {}) => new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
  const handler = async (request: Request) => {
    const url = new URL(request.url);
    // Exact host AND URL origin: redirects and routing cannot trust a rebound Host.
    if (url.origin !== origin || request.headers.get("host") !== new URL(origin).host) {
      return reply("Unexpected host", 403);
    }
    if (request.method === "POST") {
      const requestOrigin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      const nativeCli = options.allowOriginlessCli === true && requestOrigin === null && site === null;
      if ((requestOrigin !== origin && !nativeCli) || (site !== null && site !== "same-origin")) {
        return reply("Same-origin form required", 403);
      }
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        return reply(JSON.stringify(await app.snapshot()), 200, { "content-type": "application/json" });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return reply(page(await app.snapshot(), notices[url.searchParams.get("notice") ?? ""] ?? ""), 200,
          { "content-type": "text/html; charset=utf-8" });
      }
      if (request.method !== "POST") return reply("Not found", 404);
      let status: string;
      if (url.pathname === "/delegate") {
        if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
          return reply("Expected a form", 415);
        }
        const form = await request.formData();
        await app.delegate(String(form.get("goal") ?? ""), String(form.get("requestId") ?? ""));
        status = "accepted";
      } else {
        const match = /^\/tasks\/(job-[0-9a-f-]+)\/(interrupt|reconcile)$/.exec(url.pathname);
        if (!match) return reply("Not found", 404);
        status = match[2] === "interrupt" ? await app.interrupt(match[1]!) : await app.reconcile(match[1]!);
      }
      return reply(null, 303, { location: `${origin}/?notice=${status}` });
    } catch {
      return reply("The request was rejected. Refresh saved progress before making another submission.", 400);
    }
  };
  try {
    await app.snapshot();
    server = serve(handler, options.port ?? 4319);
    origin = `http://127.0.0.1:${server.port}`;
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  stop = () => closing ??= (async () => {
    // Stop accepting work first, then settle the worker before releasing SQLite.
    const settled = app.close();
    await Promise.all([server.stop(), settled]);
  })();
  return { origin, close: stop };
}
