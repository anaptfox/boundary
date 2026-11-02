import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DocumentRoom } from "./room-store";

const draft = z.object({ id: z.string(), title: z.string().min(1).max(500), body: z.string().min(1).max(16000), expectedRevision: z.number().int().positive(), richText: z.string().max(100000).optional() });
const work = z.object({ id: z.string(), goal: z.string().max(4000), owner: z.enum(["alice", "bob"]), model: z.string().max(200), steps: z.number().int().min(0).max(32), draft: draft.optional(), queue: z.array(z.enum(["scout", "editor"])).max(2).optional(), answers: z.array(z.object({ question: z.string().max(800), answer: z.string().max(4000) })).max(32).optional() });
const question = z.object({ id: z.string(), kind: z.enum(["choice", "boolean", "text", "approval"]), prompt: z.string().min(1).max(800), options: z.array(z.string().max(120)).max(6), state: z.enum(["pending", "answered", "cancelled"]), answer: z.string().max(4000).optional(), resume: z.enum(["scout", "editor"]), work });

const message = z.object({
  id: z.string(), author: z.enum(["alice", "bob", "scout", "editor", "room"]), text: z.string().max(20000), time: z.string(),
  state: z.enum(["queued", "streaming", "complete", "interrupted", "error"]), roundId: z.string().optional(), allowSave: z.boolean().optional(),
  tools: z.array(z.object({ id: z.string(), interaction: z.string(), summary: z.string(), state: z.enum(["running", "returned", "rejected", "conflict", "uncertain", "not-started"]) })),
  question: question.optional(), draft: draft.optional(),
});
export const roomDiskSchema = z.object({ version: z.number().int().nonnegative(), messages: z.array(message).max(4000), requests: z.record(z.string(), z.string()),
  active: z.object({ id: z.string(), speaker: z.enum(["scout", "editor"]).optional(), phase: z.enum(["considering", "responding", "stopping"]), saveAttempted: z.boolean() }).nullable(), storageError: z.string().optional() });

declare global { var __folioDocumentRoom: Promise<DocumentRoom> | undefined; }
export function documentRoom() {
  // Shared by the POST and event-stream handlers, including dev hot reloads.
  return globalThis.__folioDocumentRoom ??= DocumentRoom.open({
    async read() {
      try { return roomDiskSchema.parse(JSON.parse(await readFile(path.join(process.env.BOUNDARY_FOLIO_DATA_DIR ?? path.join(process.cwd(), "data"), "room.json"), "utf8"))); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    },
    async write(state) {
      const target = path.join(process.env.BOUNDARY_FOLIO_DATA_DIR ?? path.join(process.cwd(), "data"), "room.json");
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8"); await rename(temporary, target);
    },
  });
}
