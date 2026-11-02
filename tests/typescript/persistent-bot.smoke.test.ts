import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../examples/apps/typescript/persistent-bot/src/storage";

// Only the native Bun boundary is replaced. Jobs and drafts use real Node SQLite.
vi.mock("../../examples/apps/typescript/persistent-bot/src/runtime.ts", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  return {
    openDatabase(path: string): Database {
      const db = new DatabaseSync(path);
      let depth = 0;
      return {
        exec: sql => db.exec(sql),
        get: (sql, ...values) => db.prepare(sql).get(...values),
        all: (sql, ...values) => db.prepare(sql).all(...values),
        run: (sql, ...values) => { db.prepare(sql).run(...values); },
        transaction<T>(action: () => T): T {
          const name = `nested_${depth++}`;
          db.exec(`SAVEPOINT ${name}`);
          try {
            const result = action();
            db.exec(`RELEASE ${name}`);
            return result;
          } catch (error) {
            db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
            throw error;
          } finally { depth--; }
        },
        close: () => db.close(),
      };
    },
  };
});

import { PersistentBotApp, type BotOptions } from "../../examples/apps/typescript/persistent-bot/src/app";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: BotOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boundary-bot-unit-"));
  const database = join(dir, "bot.sqlite");
  const app = new PersistentBotApp(database, { startDelayMs: 0, ...options });
  cleanups.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, database };
}

function barrier() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return {
    entered,
    release: () => release(),
    async hook(signal: AbortSignal) {
      enter();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Stopped")); };
        release = () => { signal.removeEventListener("abort", abort); resolve(); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

describe("persistent bot app (Node SQLite, no sockets or Bun)", () => {
  it("accepts before effect, then persists review independently and deduplicates the submission", async () => {
    const pause = barrier();
    const { app } = await fixture({ beforeEffect: pause.hook });
    const requestId = crypto.randomUUID();
    const jobId = await app.delegate("A saved task", requestId);
    await pause.entered;
    expect((await app.snapshot()).applicationTasks).toEqual([]);
    expect(await app.delegate("A saved task", requestId)).toBe(jobId);
    pause.release();
    await vi.waitFor(async () => expect((await app.snapshot()).tasks[0]?.state).toBe("review"));
    const completed = await app.snapshot();
    expect(completed.applicationTasks).toHaveLength(1);
    expect(completed.reviews).toHaveLength(1);
    expect(await app.interrupt(jobId)).toBe("unchanged");
    expect(await app.snapshot()).toEqual(completed);
  });

  it("interrupts before dispatch and never creates an effect or a review", async () => {
    const pause = barrier();
    const { app } = await fixture({ beforeEffect: pause.hook });
    const jobId = await app.delegate("Will be interrupted", crypto.randomUUID());
    await pause.entered;
    expect(await app.interrupt(jobId)).toBe("interrupted");
    const state = await app.snapshot();
    expect(state.tasks[0]).toMatchObject({ state: "interrupted", effectState: null });
    expect(state.applicationTasks).toEqual([]);
    expect(state.reviews).toEqual([]);
  });

  it("lets an already-started effect settle without claiming interruption rolled it back", async () => {
    const pause = barrier();
    const { app } = await fixture({ afterEffect: pause.hook });
    const jobId = await app.delegate("Already applied", crypto.randomUUID());
    await pause.entered;
    expect(await app.interrupt(jobId)).toBe("settling");
    expect(await app.reconcile(jobId)).toBe("settling");
    pause.release();
    await vi.waitFor(async () => expect((await app.snapshot()).tasks[0]?.effectState).toBe("completed"));
    expect((await app.snapshot()).applicationTasks).toHaveLength(1);
  });

  it("records a lost effect response immediately and reconciles without repeating the write", async () => {
    let applications = 0;
    const { app } = await fixture({ async afterEffect() { applications++; throw new Error("Lost reply"); } });
    const jobId = await app.delegate("Uncertain draft", crypto.randomUUID());
    await vi.waitFor(async () => expect((await app.snapshot()).tasks[0]?.state).toBe("uncertain"));
    expect((await app.snapshot()).applicationTasks).toHaveLength(1);
    expect(await app.reconcile(jobId)).toBe("completed");
    expect(await app.reconcile(jobId)).toBe("unchanged");
    expect(applications).toBe(1);
    expect((await app.snapshot()).reviews).toHaveLength(1);
  });

  it("classifies an exception before dispatch as failed without effect evidence", async () => {
    const { app } = await fixture({ async beforeEffect() { throw new Error("Read/preparation failed"); } });
    await app.delegate("Fails before effect", crypto.randomUUID());
    await vi.waitFor(async () => expect((await app.snapshot()).tasks[0]).toMatchObject({ state: "failed", effectState: null }));
    expect((await app.snapshot()).applicationTasks).toEqual([]);
  });

  it("shutdown cancels waiting work and restart does not resume it", async () => {
    const pause = barrier();
    const { app, database } = await fixture({ beforeEffect: pause.hook });
    await app.delegate("Running without effect", crypto.randomUUID());
    await pause.entered;
    await app.delegate("Queued", crypto.randomUUID());
    await app.close();
    const recovered = new PersistentBotApp(database);
    try {
      const state = await recovered.snapshot();
      expect(state.tasks.map(job => job.state)).toEqual(["interrupted", "interrupted"]);
      expect(state.applicationTasks).toEqual([]);
    } finally { await recovered.close(); }
  });
});
