import type { ProjectionClient } from "./client";
import { invalidateReadsForObservation, refreshReadsForClient, type InteractionCacheScope } from "./cache";
import { createObservationParser } from "./observation-parser";

export type ObservationSubscription = Readonly<{
  /** Resolves after subscription and authoritative read refresh. */
  ready: Promise<void>;
  readonly state: "connecting" | "connected" | "disconnected" | "disposed";
  disconnect(): void;
  /** Explicitly reconnects and refreshes reads to cover any delivery gap. */
  reconnect(): Promise<void>;
  dispose(): void;
}>;

export type ObservationClientOptions = Readonly<{
  url: string;
  scope: InteractionCacheScope;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  onError?(error: Error): void;
}>;

/** Subscribe to host-selected observations. Never invokes or retries a change. */
export function subscribeToObservations(client: ProjectionClient, options: ObservationClientOptions): ObservationSubscription {
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = new Headers(options.headers);
  headers.set("accept", "text/event-stream");
  let generation = 0;
  let state: ObservationSubscription["state"] = "disconnected";
  let active: AbortController | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelReady: (() => void) | undefined;
  const stop = () => {
    generation += 1;
    active?.abort();
    active = undefined;
    const reader = activeReader;
    activeReader = undefined;
    // An injected fetch can return a body without wiring the request signal.
    // Cancel the body too so an idle read cannot retain its subscription.
    void reader?.cancel().catch(() => {});
    cancelReady?.();
    cancelReady = undefined;
    if (state !== "disposed") state = "disconnected";
  };
  const start = (): Promise<void> => {
    if (state === "disposed") return Promise.reject(new Error("observation subscription is disposed"));
    stop();
    const mine = generation;
    const abort = new AbortController();
    active = abort;
    state = "connecting";
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // A caller can inspect state/onError without awaiting readiness.
    void ready.catch(() => {});
    cancelReady = () => reject(new Error("observation subscription disconnected before readiness"));
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetcher(options.url, {
          headers, credentials: options.credentials ?? "same-origin", signal: abort.signal,
        });
        if (mine !== generation) { await response.body?.cancel(); return; }
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
          await response.body?.cancel();
          throw new Error(`observation subscription rejected (${response.status})`);
        }
        reader = response.body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder();
        const parser = createObservationParser();
        let readySeen = false;
        const dispatch = async ({ event, data }: Readonly<{ event: string; data: string }>) => {
          if (mine !== generation) return;
          if (event === "ready" && !readySeen) {
            readySeen = true;
            await refreshReadsForClient(client, options.scope);
            if (mine !== generation) return;
            state = "connected";
            cancelReady = undefined;
            resolve();
          } else if (event === "observation") {
            await invalidateReadsForObservation(JSON.parse(data), options.scope);
          }
        };
        while (mine === generation) {
          const chunk = await reader.read();
          if (mine !== generation) break;
          const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          for (const frame of parser.feed(text)) {
            await dispatch(frame);
            if (mine !== generation) break;
          }
          if (chunk.done) throw new Error("observation stream disconnected; reconnect to refresh reads");
        }
      } catch (caught) {
        if (mine !== generation) return;
        state = "disconnected";
        cancelReady = undefined;
        const error = caught instanceof Error ? caught : new Error(String(caught));
        reject(error);
        try { options.onError?.(error); } catch { /* Observers cannot revise read truth. */ }
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        if (activeReader === reader) activeReader = undefined;
        if (mine === generation) active = undefined;
      }
    })();
    return ready;
  };
  const ready = start();
  return Object.freeze({
    ready,
    get state() { return state; },
    disconnect: stop,
    reconnect: start,
    dispose() { stop(); state = "disposed"; },
  });
}
