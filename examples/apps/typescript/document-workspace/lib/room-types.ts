import type { AgentId } from "./agents";

export type RoomDraft = { id: string; title: string; body: string; expectedRevision: number; richText?: string };
export type RoomWork = { id: string; goal: string; owner: "alice" | "bob"; model: string; steps: number; draft?: RoomDraft; queue?: AgentId[]; answers?: { question: string; answer: string }[] };
export type RoomQuestionSpec = { kind: "choice" | "boolean" | "text" | "approval"; prompt: string; options: string[] };
export type RoomQuestion = RoomQuestionSpec & {
  id: string; state: "pending" | "answered" | "cancelled"; answer?: string;
  resume: AgentId; work: RoomWork;
};
export type RoomTool = { id: string; interaction: string; summary: string; state: "running" | "returned" | "rejected" | "conflict" | "uncertain" | "not-started" };
export type RoomMessage = {
  id: string; author: "alice" | "bob" | AgentId | "room"; text: string; time: string;
  state: "queued" | "streaming" | "complete" | "interrupted" | "error";
  roundId?: string; tools: RoomTool[]; allowSave?: boolean;
  question?: RoomQuestion; draft?: RoomDraft;
};
export type RoomActive = { id: string; speaker?: AgentId; phase: "considering" | "responding" | "stopping"; saveAttempted: boolean };
export type RoomSnapshot = { version: number; messages: RoomMessage[]; active: RoomActive | null; storageError?: string };
export type RoomEvent =
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "message"; version: number; message: RoomMessage }
  | { type: "text"; version: number; id: string; delta: string }
  | { type: "state"; version: number; active: RoomActive | null; storageError?: string };
export type RoomInput = { id: string; text: string; model: string; allowSave: boolean; answer?: { questionId: string; value: string } };
