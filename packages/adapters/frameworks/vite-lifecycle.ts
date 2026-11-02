import type { HttpHandler } from "@foxworth/boundary/http";

/** Vite server mode used to prepare an explicit candidate. */
export type SurfaceViteMode = "development" | "preview";

/** A host-owned implementation generation and its cleanup boundary. */
export type SurfaceViteCandidate = Readonly<{
  readonly generation: string;
  readonly handler: HttpHandler;
  readonly dispose?: () => void | Promise<void>;
}>;

/** Non-authoritative lifecycle diagnostics; observers cannot change truth. */
export type SurfaceViteDiagnostic = Readonly<{
  readonly code:
    | "CANDIDATE_REJECTED"
    | "CANDIDATE_DISPOSAL_FAILED"
    | "RETIRED_DISPOSAL_FAILED"
    | "STALE_CLIENT"
    | "NOT_READY"
    | "CLOSED";
  readonly message: string;
  readonly generation?: string;
  readonly cause?: unknown;
}>;

/** Snapshot of the published generation and lifecycle state. */
export type SurfaceViteStatus = Readonly<{
  readonly state: "idle" | "starting" | "ready" | "failed" | "closed";
  readonly generation?: string;
  readonly diagnostic?: SurfaceViteDiagnostic;
}>;

/** Explicit inputs supplied to the host entry loader. */
export type SurfaceViteEntryContext = Readonly<{
  readonly mode: SurfaceViteMode;
  readonly previousGeneration?: string;
  readonly signal: AbortSignal;
  /** Vite's native SSR loader when the host supplies one. */
  readonly loadModule?: (url: string) => Promise<Record<string, unknown>>;
}>;

/** Host callbacks for preparing, validating, and observing generations. */
export type SurfaceViteLifecycleOptions = Readonly<{
  readonly entry: (
    context: SurfaceViteEntryContext,
  ) => SurfaceViteCandidate | Promise<SurfaceViteCandidate>;
  readonly validate?: (candidate: SurfaceViteCandidate) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: SurfaceViteDiagnostic) => void;
}>;

type Lease = {
  release(): void;
  cancel(): Promise<void>;
};
type LiveCandidate = SurfaceViteCandidate & {
  active: number;
  leases: Set<Lease>;
  retired: boolean;
  disposed: boolean;
  idle: Promise<void>;
  resolveIdle: () => void;
  cleanup?: Promise<void>;
};

const freeze = <const T>(value: T): Readonly<T> => Object.freeze(value);

function validCandidate(value: SurfaceViteCandidate): void {
  if (!value || typeof value !== "object") throw new TypeError("candidate must be an object");
  if (!value.generation || typeof value.generation !== "string") throw new TypeError("candidate.generation must be a non-empty string");
  if (typeof value.handler !== "function") throw new TypeError("candidate.handler must be a function");
  if (value.dispose !== undefined && typeof value.dispose !== "function") throw new TypeError("candidate.dispose must be a function");
}

/**
 * Own explicit Vite implementation generations without rebinding outstanding
 * requests. Publication follows successful preparation and validation only.
 */
export function createSurfaceViteLifecycle(options: SurfaceViteLifecycleOptions) {
  if (typeof options.entry !== "function") throw new TypeError("entry must be a function");
  let current: LiveCandidate | undefined;
  const candidates = new Set<LiveCandidate>();
  const accepted = new WeakSet<object>();
  let status: SurfaceViteStatus = freeze({ state: "idle" });
  let lastDiagnostic: SurfaceViteDiagnostic | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const abort = new AbortController();
  let queue = Promise.resolve();

  const report = (value: SurfaceViteDiagnostic) => {
    lastDiagnostic = freeze(value);
    try { options.onDiagnostic?.(lastDiagnostic); } catch { /* observers cannot alter lifecycle truth */ }
  };
  const disposeCandidate = async (candidate: LiveCandidate | SurfaceViteCandidate, code: "CANDIDATE_DISPOSAL_FAILED" | "RETIRED_DISPOSAL_FAILED") => {
    if ("disposed" in candidate) {
      if (candidate.disposed) return;
      candidate.disposed = true;
    }
    try { await candidate.dispose?.(); }
    catch (cause) { report({ code, message: `Vite ${code === "RETIRED_DISPOSAL_FAILED" ? "retired" : "rejected"} generation disposal failed`, generation: candidate.generation, cause }); }
  };
  const cleanup = (candidate: LiveCandidate) => {
    if (candidate.cleanup || !candidate.retired || candidate.active !== 0) return candidate.cleanup;
    candidate.cleanup = disposeCandidate(candidate, "RETIRED_DISPOSAL_FAILED").then(() => { candidates.delete(candidate); candidate.resolveIdle(); });
    return candidate.cleanup;
  };
  const retire = (candidate: LiveCandidate) => { candidate.retired = true; cleanup(candidate); };

  const run = async (mode: SurfaceViteMode, kind: "start" | "replace", loadModule?: SurfaceViteEntryContext["loadModule"]) => {
    if (closed) return status;
    status = freeze({ state: "starting", ...(current ? { generation: current.generation } : {}) });
    let prepared: SurfaceViteCandidate | undefined;
    let disposePrepared = false;
    try {
      prepared = await options.entry({ mode, ...(current ? { previousGeneration: current.generation } : {}), signal: abort.signal, ...(loadModule ? { loadModule } : {}) });
      disposePrepared = !!prepared && typeof prepared === "object" && !accepted.has(prepared as object);
      validCandidate(prepared);
      if (accepted.has(prepared as object)) throw new Error("candidate object was already accepted");
      if (current?.generation === prepared.generation) throw new Error(`generation is already published: ${prepared.generation}`);
      await options.validate?.(prepared);
      if (closed) throw new Error("lifecycle closed while preparing candidate");
      let resolveIdle!: () => void;
      const next: LiveCandidate = { ...prepared, active: 0, leases: new Set(), retired: false, disposed: false, idle: new Promise(resolve => { resolveIdle = resolve; }), resolveIdle };
      accepted.add(prepared as object);
      candidates.add(next);
      const previous = current;
      current = next;
      status = freeze({ state: "ready", generation: next.generation });
      lastDiagnostic = undefined;
      if (previous) retire(previous);
      return status;
    } catch (cause) {
      if (prepared && disposePrepared) await disposeCandidate(prepared, "CANDIDATE_DISPOSAL_FAILED");
      const failure = freeze({ code: "CANDIDATE_REJECTED", message: `Vite ${kind} candidate was rejected; the previous generation remains active`, ...(prepared?.generation ? { generation: prepared.generation } : {}), cause });
      report(failure);
      status = freeze({ state: current ? "ready" : "failed", ...(current ? { generation: current.generation } : {}), diagnostic: failure });
      return status;
    }
  };
  const enqueue = (mode: SurfaceViteMode, kind: "start" | "replace", loadModule?: SurfaceViteEntryContext["loadModule"]) => { const result = queue.then(() => run(mode, kind, loadModule)); queue = result.then(() => undefined, () => undefined); return result; };
  const release = (candidate: LiveCandidate, lease: Lease) => { if (!candidate.leases.delete(lease)) return; candidate.active -= 1; if (candidate.retired && candidate.active === 0) cleanup(candidate); };

  return {
    start: (mode: SurfaceViteMode, loadModule?: SurfaceViteEntryContext["loadModule"]) => enqueue(mode, "start", loadModule),
    replace: (mode: SurfaceViteMode, loadModule?: SurfaceViteEntryContext["loadModule"]) => enqueue(mode, "replace", loadModule),
    status: () => status,
    diagnostic: () => lastDiagnostic,
    async dispatch(request: Request): Promise<Response> {
      if (closed) {
        const value = freeze({ code: "CLOSED", message: "Vite projection lifecycle is closed" });
        report(value);
        return new Response(JSON.stringify({ error: value.message, code: value.code }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      const candidate = current;
      if (!candidate) {
        const value = freeze({ code: "NOT_READY", message: "Vite projection is not ready" });
        report(value);
        return new Response(JSON.stringify({ error: value.message, code: value.code }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      const expected = request.headers.get("x-boundary-vite-generation");
      if (expected !== null && expected !== candidate.generation) {
        const value = freeze({ code: "STALE_CLIENT", message: `client generation ${expected} is stale; current generation is ${candidate.generation}`, generation: expected });
        report(value);
        return new Response(JSON.stringify({ error: value.message, code: value.code, generation: candidate.generation }), { status: 409, headers: { "content-type": "application/json; charset=utf-8", "x-boundary-vite-generation": candidate.generation } });
      }

      let released = false;
      let closeRequested = false;
      let cancelBody = async () => undefined;
      let resolveHandler!: () => void;
      let resolveBody!: () => void;
      const handlerDone = new Promise<void>(resolve => { resolveHandler = resolve; });
      const bodyReady = new Promise<void>(resolve => { resolveBody = resolve; });
      const lease: Lease = {
        release: () => { if (!released) { released = true; release(candidate, lease); } },
        cancel: async () => {
          closeRequested = true;
          try { await handlerDone; await bodyReady; await cancelBody(); }
          finally { lease.release(); }
        },
      };
      candidate.active += 1;
      candidate.leases.add(lease);
      try {
        const response = await candidate.handler(request);
        resolveHandler();
        if (!response.body) {
          resolveBody();
          lease.release();
          const headers = new Headers(response.headers);
          headers.set("x-boundary-vite-generation", candidate.generation);
          return new Response(null, { status: response.status, statusText: response.statusText, headers });
        }
        const reader = response.body.getReader();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        cancelBody = async () => {
          try { await reader.cancel(); } finally { try { controller?.error(new Error("Vite projection lifecycle closed")); } catch { /* stream already completed */ } }
        };
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          async pull(value) { try { const item = await reader.read(); if (item.done) { value.close(); lease.release(); } else value.enqueue(item.value); } catch (error) { value.error(error); lease.release(); } },
          async cancel(reason) { try { await reader.cancel(reason); } finally { lease.release(); } },
        });
        resolveBody();
        if (closeRequested) await cancelBody();
        const headers = new Headers(response.headers);
        headers.set("x-boundary-vite-generation", candidate.generation);
        return new Response(stream, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        resolveHandler();
        resolveBody();
        lease.release();
        throw error;
      }
    },
    dispose() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closed) return;
        closed = true;
        abort.abort();
        await queue;
        const live = [...candidates];
        for (const candidate of live) {
          candidate.retired = true;
          const leases = [...candidate.leases];
          await Promise.allSettled(leases.map(lease => lease.cancel()));
          cleanup(candidate);
        }
        await Promise.all(live.map(candidate => candidate.cleanup ?? candidate.idle));
        current = undefined;
        status = freeze({ state: "closed" });
      })();
      return closePromise;
    },
  };
}
