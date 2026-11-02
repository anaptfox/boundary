import { z } from "zod";
import { applicationTask } from "./interactions";

/** Native SQLite boundary implemented by this example's Bun host. */
export interface Database {
  exec(sql: string): void;
  get(sql: string, ...values: (string | number)[]): unknown;
  all(sql: string, ...values: (string | number)[]): unknown[];
  run(sql: string, ...values: (string | number)[]): void;
  transaction<T>(action: () => T): T;
  close(): void;
}

const jobSchema = z.object({
  id: z.string(),
  goal: z.string(),
  state: z.enum(["queued", "running", "review", "interrupted", "failed", "uncertain", "not-applied"]),
});
const effectSchema = z.object({
  id: z.string(),
  sourceKey: z.string(),
  state: z.enum(["started", "completed", "uncertain", "not-applied"]),
});
export const snapshotSchema = z.object({
  bot: z.object({ id: z.string(), name: z.string() }),
  conversations: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string() })),
  tasks: z.array(jobSchema.extend({ effectState: effectSchema.shape.state.nullable() })),
  progress: z.array(z.object({ taskId: z.string(), body: z.string(), createdAt: z.string() })),
  reviews: z.array(z.object({ taskId: z.string(), body: z.string(), state: z.string() })),
  applicationTasks: z.array(applicationTask),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
export const sourceKeyFor = (jobId: string) => `persistent-bot:${jobId}:draft`;

export class BotStore {
  constructor(private readonly db: Database) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS application_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL);
    `);
    db.run("INSERT OR IGNORE INTO bots (id, name) VALUES (?, ?)", "bot-planner", "Planner");
  }

  private progress(taskId: string, body: string) {
    this.db.run("INSERT INTO progress VALUES (?, ?, ?, ?)", id(), taskId, body, now());
  }

  job(taskId: string) {
    const row = this.db.get("SELECT id, goal, state FROM jobs WHERE id = ?", taskId);
    return row ? jobSchema.parse(row) : undefined;
  }

  private effect(taskId: string) {
    const row = this.db.get("SELECT id, source_key AS sourceKey, state FROM effects WHERE task_id = ?", taskId);
    return row ? effectSchema.parse(row) : undefined;
  }

  accept(goal: string, requestId: string) {
    const taskId = `job-${requestId}`;
    return this.db.transaction(() => {
      const existing = this.job(taskId);
      if (existing) {
        if (existing.goal !== goal) throw new Error("Request ID already belongs to a different delegation");
        return taskId;
      }
      const { count } = z.object({ count: z.number() }).parse(this.db.get("SELECT COUNT(*) AS count FROM jobs"));
      if (count >= 1000) throw new Error("This local example has reached its 1000-delegation limit");
      const { count: pending } = z.object({ count: z.number() }).parse(
        this.db.get("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued', 'running')"),
      );
      if (pending >= 16) throw new Error("The local queue is full (16 jobs)");
      this.db.run("INSERT INTO conversations VALUES (?, ?, ?)", requestId, goal, now());
      this.db.run("INSERT INTO jobs VALUES (?, ?, 'queued', ?)", taskId, goal, now());
      this.progress(taskId, "Delegation saved. Planner will create one application draft.");
      return taskId;
    });
  }

  next() {
    const row = this.db.get("SELECT id, goal, state FROM jobs WHERE state = 'queued' ORDER BY rowid LIMIT 1");
    return row ? jobSchema.parse(row) : undefined;
  }

  begin(taskId: string) {
    this.db.transaction(() => {
      if (this.job(taskId)?.state !== "queued") throw new Error("Job is no longer queued");
      this.db.run("UPDATE jobs SET state = 'running' WHERE id = ?", taskId);
      this.progress(taskId, "Planner is reading the saved application tasks.");
    });
  }

  startEffect(taskId: string) {
    this.db.transaction(() => {
      if (this.job(taskId)?.state !== "running" || this.effect(taskId)) throw new Error("No unstarted delegation remains");
      this.db.run("INSERT INTO effects VALUES (?, ?, ?, 'started', ?)", id(), taskId, sourceKeyFor(taskId), now());
      this.progress(taskId, "The create-task interaction has started. Interruption cannot roll it back.");
    });
  }

  listDrafts() {
    return z.array(applicationTask).parse(this.db.all(
      "SELECT id, title, source_key AS sourceKey, state FROM application_tasks ORDER BY rowid",
    ));
  }

  createDraft(taskId: string, title: string, sourceKey: string) {
    return this.db.transaction(() => {
      const job = this.job(taskId);
      if (job?.state !== "running" || job.goal !== title || sourceKey !== sourceKeyFor(taskId)
        || this.effect(taskId)?.state !== "started") throw new Error("Outside the exact delegated draft scope");
      const draft = { id: `app-${id()}`, title, sourceKey, state: "draft" as const };
      this.db.run("INSERT INTO application_tasks VALUES (?, ?, ?, ?)", draft.id, title, sourceKey, draft.state);
      return draft;
    });
  }

  complete(taskId: string, reconciled = false) {
    this.db.transaction(() => {
      this.db.run("UPDATE effects SET state = 'completed' WHERE task_id = ?", taskId);
      this.db.run("UPDATE jobs SET state = 'review' WHERE id = ?", taskId);
      this.db.run("INSERT INTO reviews VALUES (?, ?, ?, 'ready')", id(), taskId,
        "One saved application draft is ready for human inspection; no external delivery occurred.");
      this.progress(taskId, reconciled
        ? "Reconciliation observed the existing exact draft. The interaction was not repeated."
        : "The interaction completed and its saved draft is ready for review.");
    });
  }

  fail(taskId: string) {
    this.db.transaction(() => {
      const effect = this.effect(taskId);
      if (effect?.state === "started") {
        this.db.run("UPDATE effects SET state = 'uncertain' WHERE id = ?", effect.id);
        this.db.run("UPDATE jobs SET state = 'uncertain' WHERE id = ?", taskId);
        this.progress(taskId, "Work stopped after dispatch without confirmed completion. Reconcile the existing effect; do not retry it.");
      } else if (this.job(taskId)?.state === "running") {
        this.db.run("UPDATE jobs SET state = 'failed' WHERE id = ?", taskId);
        this.progress(taskId, "Work failed before an effect started. No draft was created by this job.");
      }
    });
  }

  interrupt(taskId: string): "interrupted" | "settling" | "unchanged" {
    return this.db.transaction(() => {
      const job = this.job(taskId);
      if (!job) throw new Error("Unknown job");
      if (job.state !== "queued" && job.state !== "running") return "unchanged";
      if (this.effect(taskId)) return "settling";
      this.db.run("UPDATE jobs SET state = 'interrupted' WHERE id = ?", taskId);
      this.progress(taskId, "Interruption stopped this job before an effect started.");
      return "interrupted";
    });
  }

  reconcile(taskId: string) {
    return this.db.transaction(() => {
      const effect = this.effect(taskId);
      if (effect?.state !== "uncertain") return "unchanged";
      const job = this.job(taskId);
      const row = this.db.get("SELECT id, title, source_key AS sourceKey, state FROM application_tasks WHERE source_key = ?", effect.sourceKey);
      if (row) {
        const draft = applicationTask.parse(row);
        if (draft.title !== job?.goal || draft.sourceKey !== sourceKeyFor(taskId)) return "uncertain";
        this.complete(taskId, true);
        return "completed";
      }
      this.db.run("UPDATE effects SET state = 'not-applied' WHERE id = ?", effect.id);
      this.db.run("UPDATE jobs SET state = 'not-applied' WHERE id = ?", taskId);
      this.progress(taskId, "Reconciliation found no saved draft. No effect was retried.");
      return "not-applied";
    });
  }

  recover() {
    this.db.transaction(() => {
      for (const row of this.db.all("SELECT task_id AS taskId FROM effects WHERE state = 'started'")) {
        this.fail(z.object({ taskId: z.string() }).parse(row).taskId);
      }
      for (const row of this.db.all("SELECT id FROM jobs WHERE state IN ('queued', 'running')")) {
        this.interrupt(z.object({ id: z.string() }).parse(row).id);
      }
    });
  }

  snapshot(): Snapshot {
    return snapshotSchema.parse({
      bot: this.db.get("SELECT id, name FROM bots LIMIT 1"),
      conversations: this.db.all("SELECT id, body, created_at AS createdAt FROM conversations ORDER BY rowid"),
      tasks: this.db.all("SELECT jobs.id, goal, jobs.state, effects.state AS effectState FROM jobs LEFT JOIN effects ON effects.task_id = jobs.id ORDER BY jobs.rowid"),
      progress: this.db.all("SELECT task_id AS taskId, body, created_at AS createdAt FROM progress ORDER BY rowid"),
      reviews: this.db.all("SELECT task_id AS taskId, body, state FROM reviews ORDER BY rowid"),
      applicationTasks: this.listDrafts(),
    });
  }

  close() { this.db.close(); }
}
