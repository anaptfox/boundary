import { expect, it } from "vitest";
import { createObservationHttpHandler } from "../../packages/adapters/http/observations";
import { subscribeToObservations } from "../../packages/callers/client/observations";
import { createInteractionCacheScope, mountRead } from "../../packages/callers/client/cache";
import type { ProjectionClient } from "../../packages/callers/client/client";
import type { InvocationObservation } from "../../packages/core/program/index";
import { readFileSync } from "node:fs";

const event: InvocationObservation = JSON.parse(readFileSync(new URL("../conformance/v1/composition.json", import.meta.url), "utf8")).observation;
function client(installationId = event.installationId, resources = event.changes): ProjectionClient {
  return { inspect: async () => ({
    installationId, installationDigest: event.installationDigest,
    expectedProgram: { interactions: [{ contract: { id: "screen.read", reads: resources, changes: [] } }] },
  }) } as unknown as ProjectionClient;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

it("authenticates before attaching, cleans up once when cancelled during async subscription", async () => {
  const entered = deferred<void>();
  const pending = deferred<() => void>();
  let cleaned = 0;
  const handler = createObservationHttpHandler({ path: "/events", context: () => "host-context", subscribe: async () => { entered.resolve(); return pending.promise; } });
  const abort = new AbortController();
  const response = await handler(new Request("http://boundary.test/events", { signal: abort.signal }));
  await entered.promise;
  abort.abort();
  pending.resolve(() => { cleaned += 1; });
  await response!.text();
  await Promise.resolve();
  expect(cleaned).toBe(1);
  let attached = false;
  const denied = createObservationHttpHandler({ path: "/events", context: () => new Response(null, { status: 403 }), subscribe: () => { attached = true; return () => {}; } });
  expect((await denied(new Request("http://boundary.test/events")))?.status).toBe(403);
  expect(attached).toBe(false);
});

it("refreshes after reconnect gaps, ignores other installations, and never dispatches an effect", async () => {
  const scope = createInteractionCacheScope();
  const screen = client();
  let value = "before";
  let shown = "";
  let refreshed = 0;
  let otherRefreshes = 0;
  let delivered: (() => void) | undefined;
  let publish: ((event: InvocationObservation) => void) | undefined;
  const unmount = mountRead(screen, "screen.read", async () => { shown = value; refreshed += 1; delivered?.(); }, scope);
  const unmountOther = mountRead(client("another"), "screen.read", async () => { otherRefreshes += 1; }, scope);
  let cleanups = 0;
  const handler = createObservationHttpHandler({ path: "/events", context: () => undefined, subscribe: (_, send) => { publish = send; return () => { cleanups += 1; }; } });
  const subscription = subscribeToObservations(screen, {
    url: "http://boundary.test/events", scope,
    fetch: async (input, init) => (await handler(new Request(input, init)))!,
  });
  try {
    await subscription.ready;
    expect(shown).toBe("before");
    expect(subscription.state).toBe("connected");
    value = "after-uncertain-effect";
    const changed = deferred<void>(); delivered = changed.resolve;
    publish!(event);
    await changed.promise;
    expect(shown).toBe(value);
    expect(otherRefreshes).toBe(0);
    subscription.disconnect();
    expect(subscription.state).toBe("disconnected");
    value = "changed-during-gap";
    await subscription.reconnect();
    expect(shown).toBe(value);
    expect(refreshed).toBe(3);
    subscription.dispose();
    expect(subscription.state).toBe("disposed");
    await expect(subscription.reconnect()).rejects.toThrow("disposed");
    expect(cleanups).toBe(2);
  } finally { subscription.dispose(); unmount(); unmountOther(); }
});

it("rejects oversized events and malformed frames without refreshing reads", async () => {
  const errors: Error[] = [];
  const finished = deferred<void>();
  const subscription = subscribeToObservations(client(), {
    url: "http://boundary.test/events", scope: createInteractionCacheScope(),
    fetch: async () => new Response(`data: ${"x".repeat(65_537)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    onError(error) { errors.push(error); finished.resolve(); },
  });
  await expect(subscription.ready).rejects.toThrow("size limit");
  await finished.promise;
  expect(errors).toHaveLength(1);
  expect(subscription.state).toBe("disconnected");
  subscription.dispose();
});

it("retires a pending fetch without letting its late response attach", async () => {
  const pending = deferred<Response>();
  let cancelled = false;
  const subscription = subscribeToObservations(client(), {
    url: "http://boundary.test/events", scope: createInteractionCacheScope(), fetch: () => pending.promise,
  });
  subscription.dispose();
  pending.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
  await expect(subscription.ready).rejects.toThrow("disconnected");
  await Promise.resolve();
  expect(cancelled).toBe(true);
  expect(subscription.state).toBe("disposed");
});

it("parses split CRLF frames, ignores unrelated installation events, and rejects malformed JSON", async () => {
  const scope = createInteractionCacheScope();
  const screen = client();
  let refreshed = 0;
  const unmount = mountRead(screen, "screen.read", async () => { refreshed += 1; }, scope);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const errored = deferred<void>();
  const subscription = subscribeToObservations(screen, {
    url: "http://boundary.test/events", scope,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } }),
    onError: () => errored.resolve(),
  });
  const encoder = new TextEncoder();
  await Promise.resolve();
  for (const fragment of ["event: rea", "dy\r", "\ndata: {}\r\n", "\r\n"]) controller.enqueue(encoder.encode(fragment));
  await subscription.ready;
  controller.enqueue(encoder.encode(`event: observation\r\ndata: ${JSON.stringify({ ...event, installationId: "unrelated" })}\r\n\r\n`));
  controller.enqueue(encoder.encode("event: observation\ndata: {broken\n\n"));
  await errored.promise;
  expect(refreshed).toBe(1);
  expect(subscription.state).toBe("disconnected");
  subscription.dispose(); unmount();
});

it("decodes fragmented UTF-8 and multiline CR events without dispatching an incomplete EOF event", async () => {
  const scope = createInteractionCacheScope();
  const unicodeEvent = { ...event, changes: ["notebook:😀é"] };
  const screen = client(event.installationId, unicodeEvent.changes);
  let refreshed = 0;
  const delivered = deferred<void>();
  const ended = deferred<void>();
  const errors: Error[] = [];
  const unmount = mountRead(screen, "screen.read", async () => {
    refreshed += 1;
    if (refreshed === 2) delivered.resolve();
  }, scope);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const subscription = subscribeToObservations(screen, {
    url: "http://boundary.test/events", scope,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } }),
    onError(error) { errors.push(error); ended.resolve(); },
  });
  const enqueueBytes = (text: string) => {
    for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
  };
  try {
    // The decoder owns UTF-8/BOM handling, including boundaries inside a code point.
    enqueueBytes("\ufeffevent: ready\r\ndata: {}\r\n\r\n");
    await subscription.ready;
    expect(refreshed).toBe(1);
    const lines = JSON.stringify(unicodeEvent, null, 2).split("\n").map(line => `data: ${line}\r`).join("");
    enqueueBytes(`event: observation\rdata\r${lines}data:\r\r`);
    await delivered.promise;
    expect(refreshed).toBe(2);
    enqueueBytes("event: observation\rdata: {incomplete");
    controller.close();
    await ended.promise;
    expect(errors.map(error => error.message)).toEqual(["observation stream disconnected; reconnect to refresh reads"]);
    expect(refreshed).toBe(2);
    expect(subscription.state).toBe("disconnected");
  } finally { subscription.dispose(); unmount(); }
});

it("requires a completed data-bearing ready event before refreshing reads", async () => {
  const scope = createInteractionCacheScope();
  const screen = client();
  let refreshed = 0;
  const unmount = mountRead(screen, "screen.read", async () => { refreshed += 1; }, scope);
  const subscription = subscribeToObservations(screen, {
    url: "http://boundary.test/events", scope,
    fetch: async () => new Response("event: ready\n\nevent: ready\ndata: {}\n", { headers: { "content-type": "text/event-stream" } }),
  });
  try {
    await expect(subscription.ready).rejects.toThrow("disconnected");
    expect(refreshed).toBe(0);
  } finally { subscription.dispose(); unmount(); }
});

for (const action of ["disconnect", "dispose", "reconnect"] as const) {
  it(`cancels an idle body on ${action} when injected fetch ignores abort`, async () => {
    const cancelled: number[] = [];
    const errors: Error[] = [];
    let opened = 0;
    const subscription = subscribeToObservations(client(), {
      url: "http://boundary.test/events", scope: createInteractionCacheScope(),
      fetch: async () => {
        const id = ++opened;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
          },
          cancel() { cancelled.push(id); },
        }), { headers: { "content-type": "text/event-stream" } });
      },
      onError(error) { errors.push(error); },
    });
    try {
      await subscription.ready;
      // Let the consumer enter reader.read() with no more data forthcoming.
      await Promise.resolve();
      if (action === "reconnect") await subscription.reconnect();
      else subscription[action]();
      await Promise.resolve();
      expect(cancelled).toEqual([1]);
      expect(subscription.state).toBe(action === "reconnect" ? "connected" : action === "dispose" ? "disposed" : "disconnected");
      expect(errors).toEqual([]);
    } finally { subscription.dispose(); }
    await Promise.resolve();
    expect(cancelled).toEqual(action === "reconnect" ? [1, 2] : [1]);
  });
}
