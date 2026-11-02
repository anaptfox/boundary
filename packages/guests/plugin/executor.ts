/** The host owns preparation, admission, concurrency, and worker lifetime. */
import type { PluginInspection } from "./host.ts";
import { fault, type GuestInstance, type PluginFault, type PluginHostFunction } from "./execution-types.ts";
import { DEFAULT_EXECUTOR_LIMITS, type ExecutorLimits, type ExecutorOptions } from "./worker-protocol.ts";
import { WorkerSlot } from "./executor-worker.ts";

export type { ExecutorOptions } from "./worker-protocol.ts";
export type ExecutorStats = {
  workers: number;
  instances: number;
  /** Waiting jobs; active jobs are reported separately. */
  pending: number;
  active: number;
  preparations: number;
  compilations: number;
  cacheHits: number;
  preparedBytes: number;
  prepareMs: number;
  compileMs: number;
  instantiateMs: number;
  invokeMs: number;
};

export class PluginExecutor {
  readonly limits: Readonly<ExecutorLimits>;
  private readonly resourceLimits: ExecutorOptions["resourceLimits"];
  private readonly slots = new Map<string, WorkerSlot>();
  private readonly retiring = new Set<WorkerSlot>();
  private closed = false;
  private bindingSequence = 0;
  private closePromise?: Promise<void>;
  private totals = { preparations: 0, compilations: 0, cacheHits: 0,
    prepareMs: 0, compileMs: 0, instantiateMs: 0, invokeMs: 0 };

  constructor(options: ExecutorOptions = {}) {
    const { resourceLimits, ...overrides } = options;
    const limits = { ...DEFAULT_EXECUTOR_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    }
    for (const name of ["callTimeoutMs", "prepareTimeoutMs"] as const) {
      if (limits[name] > 2_147_483_647) throw new RangeError(`${name} exceeds the maximum timer duration`);
    }
    if (resourceLimits !== undefined) {
      for (const [name, value] of Object.entries(resourceLimits)) {
        if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
      }
    }
    this.limits = Object.freeze(limits);
    this.resourceLimits = resourceLimits === undefined ? undefined : { ...resourceLimits };
  }

  /** Validate before copying or inspecting a component supplied to this executor. */
  assertArtifactSize(bytes: Uint8Array): void {
    if (bytes.byteLength > this.limits.maxArtifactBytes) throw new RangeError("plugin artifact exceeds the byte limit");
  }

  stats(): ExecutorStats {
    const slots = [...this.slots.values()];
    return {
      ...this.totals,
      workers: slots.length + this.retiring.size,
      instances: slots.reduce((sum, slot) => sum + slot.bindings.size, 0),
      pending: slots.reduce((sum, slot) => sum + slot.queue.length, 0),
      active: slots.filter((slot) => slot.active !== undefined).length,
      preparedBytes: slots.reduce((sum, slot) => sum + slot.preparedBytes, 0),
    };
  }

  private hasCapacity(): boolean {
    const stats = this.stats();
    return stats.pending + stats.active < this.limits.maxPending;
  }

  private async artifact(bytes: Uint8Array, digest: string): Promise<WorkerSlot | PluginFault> {
    if (this.closed) return fault("plugin executor is closed");
    const cached = this.slots.get(digest);
    if (cached !== undefined) {
      this.totals.cacheHits++;
      cached.reservations++;
      return cached;
    }
    if (this.slots.size + this.retiring.size >= this.limits.maxWorkers) {
      const idle = [...this.slots.values()]
        .filter((slot) => slot.bindings.size === 0 && slot.reservations === 0 && slot.active === undefined && slot.queue.length === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) return fault("plugin executor worker capacity is exhausted");
      await idle.stop("idle plugin artifact evicted");
      return this.artifact(bytes, digest);
    }
    try {
      this.totals.preparations++;
      const slot = new WorkerSlot(digest, bytes, this.limits, this.resourceLimits, {
        prepared: (_slot, event) => {
          this.totals.compilations += event.modules;
          this.totals.prepareMs += event.prepareMs;
          this.totals.compileMs += event.compileMs;
          return this.stats().preparedBytes + event.bytes <= this.limits.maxPreparedBytes;
        },
        result: (event) => {
          this.totals.instantiateMs += event.instantiateMs;
          this.totals.invokeMs += event.invokeMs;
        },
        stopped: (stopped) => {
          if (this.slots.get(digest) === stopped) this.slots.delete(digest);
          this.retiring.add(stopped);
          void stopped.stop("plugin worker stopped").finally(() => this.retiring.delete(stopped));
        },
      });
      this.slots.set(digest, slot);
      slot.reservations++;
      return slot;
    } catch (error) {
      return fault(`plugin worker could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async bind(
    bytes: Uint8Array,
    inspection: PluginInspection,
    host: Readonly<Record<string, PluginHostFunction>>,
  ): Promise<GuestInstance | PluginFault> {
    try { this.assertArtifactSize(bytes); }
    catch (error) { return fault(error instanceof Error ? error.message : String(error)); }
    if (this.closed) return fault("plugin executor is closed");
    if (inspection.check.status !== "satisfied") return fault("plugin inspection did not admit the artifact");
    if (this.stats().instances >= this.limits.maxInstances) return fault("plugin executor instance capacity is exhausted");
    if (!this.hasCapacity()) return fault("plugin executor queue capacity is exhausted");
    const slot = await this.artifact(bytes, inspection.componentDigest);
    if (!(slot instanceof WorkerSlot)) return slot;
    slot.reservations--;
    if (this.closed || !slot.alive) return fault("plugin executor is closed");
    // Recheck after awaiting worker eviction: another bind may have taken capacity.
    if (this.stats().instances >= this.limits.maxInstances) return fault("plugin executor instance capacity is exhausted");
    if (!this.hasCapacity()) return fault("plugin executor queue capacity is exhausted");
    const id = ++this.bindingSequence;
    slot.bindings.set(id, Object.freeze({ ...host }));
    const outcome = await slot.enqueue({ type: "bind", binding: id,
      required: inspection.required, lifetime: inspection.lifetime }, { timeoutMs: this.limits.prepareTimeoutMs });
    if (outcome.status === "fault") {
      await slot.closeBinding(id);
      return outcome;
    }
    if (!slot.alive || !slot.bindings.has(id)) return fault("plugin binding closed before admission completed", "unknown");
    return {
      call: async (name, input, options) => {
        if (this.closed || !slot.alive || !slot.bindings.has(id)) return fault("plugin binding is closed");
        if (typeof input !== "string" || Buffer.byteLength(input) > this.limits.maxPayloadBytes) return fault("plugin input exceeds the payload limit");
        if (!this.hasCapacity()) return fault("plugin executor queue capacity is exhausted");
        return slot.enqueue({ type: "call", binding: id, name, input }, options);
      },
      close: () => slot.closeBinding(id),
    };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.all([...new Set([...this.slots.values(), ...this.retiring])]
      .map((slot) => slot.stop("plugin executor is closed"))).then(() => undefined);
    return this.closePromise;
  }
}

export function createPluginExecutor(options?: ExecutorOptions): PluginExecutor {
  return new PluginExecutor(options);
}
