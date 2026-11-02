import { z } from "zod";
import { createBotHost } from "./host";
import { openDatabase } from "./runtime.ts";
import { BotStore, sourceKeyFor } from "./storage";
export type { Snapshot } from "./storage";

export type BotOptions = Readonly<{
  /** A local queue window lets a human interrupt before drafting starts. */
  startDelayMs?: number;
  /** Test barriers/faults configured by the host, never from HTTP input. */
  beforeEffect?: (signal: AbortSignal) => Promise<void>;
  afterEffect?: (signal: AbortSignal) => Promise<void>;
  onFatal?: (error: unknown) => void;
}>;

export class PersistentBotApp {
  private readonly ready: Promise<Awaited<ReturnType<typeof createBotHost>>>;
  private readonly store: BotStore;
  private readonly delay: number;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private stopping = false;
  private closing?: Promise<void>;
  private fatal?: unknown;

  constructor(databasePath: string, private readonly options: BotOptions = {}) {
    this.delay = z.number().int().min(0).max(1000).parse(options.startDelayMs ?? 500);
    const db = openDatabase(databasePath);
    try { this.store = new BotStore(db); }
    catch (error) { db.close(); throw error; }
    this.ready = createBotHost(this.store).then(host => {
      try { this.store.recover(); return host; }
      catch (error) { host.close(); throw error; }
    });
    void this.ready.catch(() => undefined);
  }

  async delegate(goal: string, requestId: string) {
    await this.ready;
    if (this.stopping) throw new Error("The host is stopping");
    const body = z.string().trim().min(1).max(240).parse(goal);
    const key = z.uuid().parse(requestId);
    const taskId = this.store.accept(body, key);
    this.schedule();
    return taskId;
  }

  private schedule() {
    if (this.stopping || this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const abort = new AbortController();
      let job;
      try { job = this.store.next(); }
      catch (error) { this.failHost(error); return; }
      if (!job) return;
      const taskId = job.id;
      const done = this.run(taskId, abort.signal)
        .catch(error => this.failHost(error))
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
      this.active = { id: taskId, abort, done };
    }, this.delay);
  }

  private failHost(error: unknown) {
    this.fatal = error;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.options.onFatal?.(error);
  }

  private async run(taskId: string, signal: AbortSignal) {
    try {
      const host = await this.ready;
      if (signal.aborted || this.store.job(taskId)?.state !== "queued") return;
      this.store.begin(taskId);
      const actor = { id: "bot-planner" as const, jobId: taskId };
      await host.caller.call(host.projection.handles.listTasks, actor);
      await this.options.beforeEffect?.(signal);
      if (signal.aborted || this.store.job(taskId)?.state !== "running") return;
      const job = this.store.job(taskId)!;
      this.store.startEffect(taskId);
      await host.caller.call(host.projection.handles.createTask, {
        title: job.goal,
        sourceKey: sourceKeyFor(taskId),
      }, actor);
      await this.options.afterEffect?.(signal);
      this.store.complete(taskId);
    } catch {
      // A failure to persist this classification is fatal; dispatch is never retried.
      this.store.fail(taskId);
    }
  }

  async interrupt(taskId: string) {
    await this.ready;
    if (this.stopping) throw new Error("The host is stopping");
    const status = this.store.interrupt(taskId);
    if (status === "interrupted" && this.active?.id === taskId) this.active.abort.abort();
    return status;
  }

  async reconcile(taskId: string) {
    await this.ready;
    if (this.stopping) throw new Error("The host is stopping");
    if (this.active?.id === taskId) return "settling";
    return this.store.reconcile(taskId);
  }

  async snapshot() {
    await this.ready;
    if (this.fatal) throw new Error("The host could not persist job status");
    return this.store.snapshot();
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let host: Awaited<typeof this.ready> | undefined;
    try {
      host = await this.ready;
      for (const task of this.store.snapshot().tasks) {
        if (task.state === "queued" || task.state === "running") this.store.interrupt(task.id);
      }
      this.active?.abort.abort();
      await this.active?.done;
    } finally {
      host?.close();
      this.store.close();
    }
  }
}
