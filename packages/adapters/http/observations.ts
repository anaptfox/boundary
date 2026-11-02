import { validateInvocationObservation, type InvocationObservation } from "@foxworth/boundary/program";

type MaybePromise<T> = T | Promise<T>;

export type ObservationHttpOptions<Context> = Readonly<{
  path: string;
  /** Authenticate on the host. Return a Response to reject the subscription. */
  context(request: Request): MaybePromise<Context | Response>;
  /** The host selects recipients, redacts correlation, and owns delivery. */
  subscribe(context: Context, publish: (event: InvocationObservation) => void, signal: AbortSignal): MaybePromise<() => void>;
}>;

/** Live, bounded SSE delivery. No replay log, authority, or effect execution. */
export function createObservationHttpHandler<Context>(options: ObservationHttpOptions<Context>) {
  if (!options.path.startsWith("/") || options.path.includes("?") || options.path.includes("#")) {
    throw new TypeError("observation path must be an absolute pathname");
  }
  const encoder = new TextEncoder();
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== options.path) return null;
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const context = await options.context(request);
    if (context instanceof Response) return context;
    const abort = new AbortController();
    let cleanup: (() => void) | undefined;
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      request.signal.removeEventListener("abort", onAbort);
      const release = cleanup;
      cleanup = undefined;
      try { release?.(); } catch { /* Delivery cleanup cannot revise host truth. */ }
    };
    const onAbort = () => {
      stop();
      try { controller.close(); } catch { /* The reader may already have cancelled. */ }
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        controller = streamController;
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) { onAbort(); return; }
        try {
          const release = await options.subscribe(context, (value) => {
            if (closed) return;
            const event = validateInvocationObservation(value);
            const encoded = encoder.encode(`event: observation\ndata: ${JSON.stringify(event)}\n\n`);
            if (encoded.byteLength > 65_536 || (controller.desiredSize ?? 0) <= 0) {
              stop();
              controller.error(new Error("observation subscriber exceeded its bounded buffer"));
              return;
            }
            controller.enqueue(encoded);
          }, abort.signal);
          if (typeof release !== "function") throw new TypeError("observation subscription must return cleanup");
          if (closed) { release(); return; }
          cleanup = release;
          // Register first, then refresh the client's authoritative reads. Writes
          // during the initial refresh still have a subscribed delivery path.
          controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
        } catch (error) {
          stop();
          controller.error(error);
        }
      },
      cancel: stop,
    }, { highWaterMark: 32 });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };
}
