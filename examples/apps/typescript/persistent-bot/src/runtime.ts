// @ts-nocheck — Bun sqlite/serve; callers use the typed exports below.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import type { Database as StoreDatabase } from "./storage";

// One host per canonical database path. Process death releases the OS lock.
export function openDatabase(path: string): StoreDatabase {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  const lock = new Database(`${canonical}.host-lock.sqlite`, { create: true });
  let db;
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    db = new Database(canonical, { create: true });
  } catch (error) {
    lock.close();
    throw error;
  }
  return {
    exec: (sql) => db.exec(sql),
    get: (sql, ...values) => db.query(sql).get(...values),
    all: (sql, ...values) => db.query(sql).all(...values),
    run: (sql, ...values) => { db.query(sql).run(...values); },
    transaction: (action) => db.transaction(action).immediate(),
    close() {
      try { db.close(); } finally { lock.close(); }
    },
  };
}

export function serve(
  fetch: (request: Request) => Promise<Response>,
  port: number,
): { port: number; stop(): Promise<void> } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 4096,
    fetch,
  });
  return { port: server.port, stop: async () => { await server.stop(true); } };
}
