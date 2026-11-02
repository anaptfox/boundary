/** One artifact's queue, capability bridge, and interruptible worker lifetime. */
import { Worker } from "node:worker_threads";
import { fault, type PluginCallOptions, type PluginCallResult, type PluginHostFunction } from "./execution-types.ts";
import type { ExecutorLimits, ExecutorOptions, WorkerCommand, WorkerEvent } from "./worker-protocol.ts";

type Command = Exclude<WorkerCommand, { type: "close" }>;
type PendingCommand = Command extends infer C ? C extends Command ? Omit<C, "job"> : never : never;
type Host = Readonly<Record<string, PluginHostFunction>>;
type Job = {
  command: Command;
  resolve: (result: PluginCallResult) => void;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
};
export type SlotCallbacks = {
  prepared: (slot: WorkerSlot, event: Extract<WorkerEvent, { type: "prepared" }>) => boolean;
  result: (event: Extract<WorkerEvent, { type: "result" }>) => void;
  stopped: (slot: WorkerSlot) => void;
};

export class WorkerSlot {
  readonly bindings = new Map<number, Host>();
  readonly queue: Job[] = [];
  active?: Job;
  alive = true;
  ready = false;
  preparedBytes = 0;
  /** Binds admitted by the cache that have not yet registered their handle. */
  reservations = 0;
  lastUsed = performance.now();
  private sequence = 0;
  private worker: Worker;
  private prepareTimer: ReturnType<typeof setTimeout>;
  private termination?: Promise<void>;

  constructor(
    readonly digest: string,
    bytes: Uint8Array,
    private readonly limits: ExecutorLimits,
    resourceLimits: ExecutorOptions["resourceLimits"],
    private readonly callbacks: SlotCallbacks,
  ) {
    const copy = new Uint8Array(bytes);
    this.worker = new Worker(new URL("./plugin-worker.ts", import.meta.url), {
      workerData: { bytes: copy, maxPreparedBytes: limits.maxPreparedBytes, maxPayloadBytes: limits.maxPayloadBytes,
        hostcallCopyBytes: limits.hostcallCopyBytes },
      transferList: [copy.buffer], resourceLimits,
    });
    this.prepareTimer = setTimeout(() => { void this.stop("plugin preparation deadline exceeded"); }, limits.prepareTimeoutMs);
    this.worker.on("message", (event: WorkerEvent) => this.receive(event));
    this.worker.on("error", (error) => { void this.stop(`plugin worker failed: ${error instanceof Error ? error.message : String(error)}`); });
    this.worker.on("exit", (code) => { if (this.alive) void this.stop(`plugin worker exited (${code})`); });
  }

  enqueue(command: PendingCommand, options: PluginCallOptions = {}): Promise<PluginCallResult> {
    if (!this.alive || !this.bindings.has(command.binding)) return Promise.resolve(fault("plugin binding is closed"));
    if (options.signal?.aborted) return Promise.resolve(fault("plugin call aborted before execution"));
    const timeout = options.timeoutMs ?? this.limits.callTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      return Promise.resolve(fault("plugin deadline must be a positive integer no greater than 2147483647 ms"));
    }
    return new Promise((resolve) => {
      const job: Job = {
        command: { ...command, job: ++this.sequence } as Command,
        resolve, controller: new AbortController(),
        timer: setTimeout(() => this.cancel(job, "plugin call deadline exceeded"), timeout),
        signal: options.signal,
        abort: () => this.cancel(job, "plugin call aborted"),
      };
      options.signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  private settle(job: Job, result: PluginCallResult): void {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    job.resolve(result);
  }

  private cancel(job: Job, reason: string): void {
    if (this.active === job) { void this.stop(reason); return; }
    const index = this.queue.indexOf(job);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.settle(job, fault(reason));
  }

  private dispatch(): void {
    if (!this.alive || !this.ready || this.active !== undefined) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.active = next;
    this.lastUsed = performance.now();
    try { this.worker.postMessage(next.command); }
    catch (error) { void this.stop(`plugin dispatch failed: ${String(error)}`); }
  }

  private receive(event: WorkerEvent): void {
    if (!this.alive) return;
    if (event.type === "prepared") {
      clearTimeout(this.prepareTimer);
      if (!this.callbacks.prepared(this, event)) { void this.stop("prepared plugin cache exceeds its byte limit"); return; }
      this.preparedBytes = event.bytes;
      this.ready = true;
      this.dispatch();
    } else if (event.type === "prepare-failed") {
      void this.stop(event.reason);
    } else if (event.type === "host") {
      void this.hostCall(event);
    } else if (event.type === "result") {
      const job = this.active;
      if (job === undefined || job.command.job !== event.job) return;
      this.active = undefined;
      this.lastUsed = performance.now();
      this.callbacks.result(event);
      this.settle(job, event.outcome);
      this.dispatch();
    }
  }

  private async hostCall(event: Extract<WorkerEvent, { type: "host" }>): Promise<void> {
    const job = this.active;
    if (job === undefined || job.command.job !== event.job || job.command.binding !== event.binding) {
      void this.stop("plugin worker requested a capability outside its active invocation");
      return;
    }
    let text: string;
    let status = 1;
    try {
      const fn = this.bindings.get(event.binding)?.[event.name];
      if (fn === undefined) throw new Error(`plugin capability ${event.name} is unavailable`);
      const reply = await fn(event.request, { signal: job.controller.signal });
      if (typeof reply !== "string" && (reply === null || typeof reply !== "object"
        || !["ok", "err", "unknown"].includes(reply.tag) || typeof reply.val !== "string")) {
        throw new Error("plugin capability returned an invalid reply");
      }
      text = JSON.stringify(reply);
      if (Buffer.byteLength(text) > this.limits.maxPayloadBytes) throw new Error("plugin capability reply exceeds the payload limit");
    } catch (error) {
      status = 2;
      text = error instanceof Error ? error.message : String(error);
    }
    // A terminated invocation cannot resume, even if its host effect finishes later.
    if (!this.alive || this.active !== job) return;
    const header = new Int32Array(event.shared, 0, 2);
    const output = new Uint8Array(event.shared, 8);
    const encoded = new TextEncoder().encode(text);
    const count = Math.min(output.length, encoded.byteLength);
    output.set(encoded.subarray(0, count));
    Atomics.store(header, 1, count);
    Atomics.store(header, 0, status);
    Atomics.notify(header, 0);
  }

  async closeBinding(binding: number): Promise<void> {
    if (!this.alive) { await this.stop("plugin binding is closed"); return; }
    if (!this.bindings.delete(binding)) return;
    if (this.active?.command.binding === binding) { await this.stop("plugin binding closed during execution"); return; }
    for (const job of [...this.queue]) {
      if (job.command.binding === binding) this.cancel(job, "plugin binding is closed");
    }
    if (this.alive) this.worker.postMessage({ type: "close", binding } satisfies WorkerCommand);
    this.lastUsed = performance.now();
  }

  stop(reason: string): Promise<void> {
    if (this.termination !== undefined) return this.termination;
    this.alive = false;
    // Publish termination before notifying host abort listeners, which may
    // synchronously close this executor again.
    this.termination = this.worker.terminate().then(() => undefined);
    clearTimeout(this.prepareTimer);
    const active = this.active;
    this.active = undefined;
    if (active !== undefined) {
      active.controller.abort();
      this.settle(active, fault(reason, "unknown"));
    }
    for (const job of this.queue.splice(0)) this.settle(job, fault(reason));
    this.bindings.clear();
    this.callbacks.stopped(this);
    return this.termination;
  }
}
