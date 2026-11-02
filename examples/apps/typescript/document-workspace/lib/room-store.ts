import { randomUUID, createHash } from "node:crypto";
import type { DemoContext } from "./context";
import type { AgentId } from "./agents";
import type { RoomActive, RoomDraft, RoomEvent, RoomInput, RoomMessage, RoomQuestionSpec, RoomSnapshot, RoomTool, RoomWork } from "./room-types";

export type RoomDisk = RoomSnapshot & { requests: Record<string, string> };
export type RoomPersistence = { read: () => Promise<RoomDisk | undefined>; write: (state: RoomDisk) => Promise<void> };
export type RoomTurn = {
  input: RoomInput; context: DemoContext; signal: AbortSignal;
  work: RoomWork; resume?: AgentId; approvedDraft?: RoomDraft; keptDraft?: boolean;
  history: () => RoomMessage[];
  begin: (speaker: AgentId) => Promise<string>;
  text: (id: string, delta: string) => void;
  tool: (id: string, tool: RoomTool) => Promise<void>;
  finish: (id: string) => Promise<void>;
  claimSave: () => Promise<boolean>;
  draft: (id: string, draft: RoomDraft) => Promise<void>;
  ask: (id: string, question: RoomQuestionSpec, resume: AgentId) => Promise<void>;
};
export type RoomDriver = (turn: RoomTurn) => Promise<void>;
/** Only fixed app-authored explanations are surfaced; provider errors stay private. */
export class RoomWorkStoppedError extends Error {}
type Job = { input: RoomInput; context: DemoContext; work: RoomWork; resume?: AgentId; approvedDraft?: RoomDraft; keptDraft?: boolean };

/** One demo room, one process. No scheduling or world semantics escape this app. */
export class DocumentRoom {
  private messages: RoomMessage[] = [];
  private requests: Record<string, string> = {};
  private version = 0;
  private active: RoomActive | null = null;
  private pending: Job | undefined;
  private controller: AbortController | undefined;
  private working: Promise<void> | undefined;
  private writes = Promise.resolve();
  private mutations = Promise.resolve();
  private listeners = new Set<(event: RoomEvent) => void>();
  private storageError: string | undefined;
  private constructor(private persistence: RoomPersistence) {}

  static async open(persistence: RoomPersistence) {
    const room = new DocumentRoom(persistence);
    const disk = await persistence.read();
    if (disk) {
      room.messages = disk.messages; room.requests = disk.requests; room.version = disk.version;
      room.storageError = disk.storageError;
      let interrupted = Boolean(disk.active);
      for (const message of room.messages) {
        if (message.state === "streaming" || message.state === "queued") { message.state = "interrupted"; interrupted = true; }
        for (const tool of message.tools) if (tool.state === "running") { tool.state = "uncertain"; tool.summary = "Process ended before a result was recorded. Inspect saved state; do not retry."; }
        if (disk.active && message.question?.state === "pending") message.question.state = "cancelled";
      }
      if (interrupted) {
        room.notice("The server restarted during an exchange. Unfinished work was stopped, not replayed. Inspect the saved document before another edit.");
        await room.persist();
      }
    }
    return room;
  }
  snapshot(): RoomSnapshot {
    return structuredClone({ version: this.version, messages: this.messages, active: this.active, ...(this.storageError ? { storageError: this.storageError } : {}) });
  }
  subscribe(listener: (event: RoomEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: RoomEvent) { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { this.listeners.delete(listener); } } }
  private changed(message: RoomMessage) { this.emit({ type: "message", version: ++this.version, message }); }
  private state() { this.emit({ type: "state", version: ++this.version, active: this.active, ...(this.storageError ? { storageError: this.storageError } : {}) }); }
  private notice(text: string) {
    const message: RoomMessage = { id: randomUUID(), author: "room", text, time: new Date().toISOString(), state: "complete", tools: [] };
    this.messages.push(message); this.changed(message);
  }
  private persist() {
    const disk: RoomDisk = { ...this.snapshot(), requests: { ...this.requests } };
    const write = this.writes.then(() => this.persistence.write(disk));
    this.writes = write.catch(() => {
      this.storageError = "Room storage is unavailable. Work is stopped; inspect saved state before another edit.";
      this.controller?.abort(); this.state();
    });
    return write;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(fn);
    this.mutations = run.then(() => {}, () => {});
    return run;
  }
  private cancelQuestions() {
    for (const message of this.messages) if (message.question?.state === "pending") {
      message.question.state = "cancelled"; this.changed(message);
    }
  }
  async submit(context: DemoContext, input: RoomInput) {
    return this.serial(async () => {
      if (this.storageError) throw new Error(this.storageError);
      const signature = createHash("sha256").update(JSON.stringify({ input, session: context.session, canEdit: context.canEdit })).digest("hex");
      if (this.requests[input.id]) {
        if (this.requests[input.id] !== signature) throw new Error("That message id already belongs to another submission.");
        return { duplicate: true };
      }
      if (this.messages.filter((message) => message.author === "alice" || message.author === "bob").length >= 100) throw new Error("This conversation has reached its 100-message limit. Reset chat to start fresh.");
      const job: Job = { input, context: { ...context, assistantMaySave: false }, work: { id: input.id, goal: input.text, owner: context.session, model: input.model, steps: 0 } };
      if (input.answer) {
        if (this.active || this.pending || this.working) throw new Error("Question is not ready. Wait for the exchange to settle.");
        const asked = this.messages.find((item) => item.question?.id === input.answer!.questionId);
        const question = asked?.question;
        if (!question || question.state !== "pending") throw new Error("Question is no longer pending. Reconnect to inspect the room.");
        if (question.work.owner !== context.session) throw new Error("Question belongs to the other participant.");
        const value = input.answer.value.trim();
        if (!value || value.length > 4000) throw new Error("Question needs an answer of 1–4000 characters.");
        if (question.kind === "approval" && value !== "Apply" && value !== "Keep as draft") throw new Error("Question requires Apply or Keep as draft.");
        if (question.kind === "approval" && value === "Apply" && (!context.canEdit || !question.work.draft)) throw new Error("Question cannot authorize this session to edit.");
        if (question.kind === "approval" && value === "Apply" && this.messages.some((item) => item.tools.some((tool) => tool.interaction === "documents.save" && tool.state === "uncertain"))) throw new Error("Question cannot start another save while an earlier outcome is uncertain.");
        job.work = structuredClone(question.work); job.resume = question.resume;
        job.work.answers = [...(job.work.answers ?? []), { question: question.prompt, answer: value }];
        job.input = { ...input, text: `Answer to ${question.prompt}: ${value}`, model: question.work.model, allowSave: false };
        if (question.kind === "approval") {
          job.approvedDraft = value === "Apply" ? structuredClone(question.work.draft) : undefined;
          job.keptDraft = value === "Keep as draft";
          job.context = { ...job.context, assistantMaySave: Boolean(job.approvedDraft) };
        }
        question.state = "answered"; question.answer = value; this.changed(asked!);
      } else this.cancelQuestions();
      const message: RoomMessage = { id: input.id, author: context.session, text: job.input.text, time: new Date().toISOString(), state: "queued", tools: [], allowSave: Boolean(job.approvedDraft) };
      this.requests[input.id] = signature;
      this.messages.push(message); this.changed(message);
      if (this.pending) { const superseded = this.messages.find((item) => item.id === this.pending!.input.id)!; superseded.state = "interrupted"; this.changed(superseded); }
      this.pending = job;
      if (this.active) { this.active.phase = "stopping"; this.controller?.abort(); this.state(); }
      await this.persist();
      return { duplicate: false };
    });
  }
  async stop() {
    return this.serial(async () => {
      this.cancelQuestions();
      if (this.pending) { const message = this.messages.find((item) => item.id === this.pending!.input.id)!; message.state = "interrupted"; this.changed(message); this.pending = undefined; }
      if (this.active) { this.active.phase = "stopping"; this.controller?.abort(); this.state(); }
      await this.persist();
    });
  }
  /** Clear conversational context only, after all started work has settled. */
  async reset(): Promise<"reset" | "busy" | "uncertain"> {
    return this.serial(async () => {
      if (this.storageError) throw new Error(this.storageError);
      if (this.active || this.pending || this.working) return "busy";
      if (this.messages.some((message) => message.tools.some((tool) => tool.interaction === "documents.save" && tool.state === "uncertain"))) return "uncertain";
      const previous = this.messages;
      this.messages = []; this.version++;
      // Keep accepted IDs, not old conversation text: reset must not make a
      // delayed duplicate request eligible to execute an old save again.
      try { await this.persist(); }
      catch { this.messages = previous; this.emit({ type: "snapshot", snapshot: this.snapshot() }); throw new Error("Reset persistence failed."); }
      this.emit({ type: "snapshot", snapshot: this.snapshot() });
      return "reset";
    });
  }
  /** Called from Next after(). A reconnect is read-only and never starts this. */
  work(driver: RoomDriver): Promise<void> {
    if (this.working) return this.working;
    this.working = this.drain(driver).finally(() => { this.working = undefined; });
    return this.working;
  }
  private async drain(driver: RoomDriver) {
    while (this.pending && !this.storageError) {
      const job = this.pending; this.pending = undefined;
      const controller = new AbortController(); this.controller = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]);
      const active: RoomActive = { id: job.input.id, phase: "considering", saveAttempted: false };
      this.active = active; this.state();
      const human = this.messages.find((message) => message.id === job.input.id)!;
      human.state = "complete"; this.changed(human);
      try {
        await this.persist();
        await driver({ ...job, signal,
          history: () => structuredClone(this.messages),
          begin: async (speaker) => {
            signal.throwIfAborted(); active.speaker = speaker; active.phase = "responding"; this.state();
            const message: RoomMessage = { id: randomUUID(), author: speaker, text: "", time: new Date().toISOString(), state: "streaming", roundId: active.id, tools: [] };
            this.messages.push(message); this.changed(message); await this.persist(); return message.id;
          },
          text: (id, delta) => {
            if (signal.aborted) return;
            const message = this.messages.find((item) => item.id === id)!;
            if (message.text.length + delta.length > 16000) throw new Error("Reply exceeded the demo room limit.");
            message.text += delta; this.emit({ type: "text", version: ++this.version, id, delta });
          },
          tool: async (id, tool) => {
            const message = this.messages.find((item) => item.id === id)!;
            const index = message.tools.findIndex((item) => item.id === tool.id);
            if (index < 0) message.tools.push(tool); else message.tools[index] = tool;
            this.changed(message); await this.persist();
          },
          draft: async (id, draft) => this.serial(async () => {
            signal.throwIfAborted(); job.work.draft = structuredClone(draft);
            const message = this.messages.find((item) => item.id === id)!;
            message.draft = structuredClone(draft); this.changed(message); await this.persist();
          }),
          ask: async (id, question, resume) => this.serial(async () => {
            signal.throwIfAborted();
            if (this.messages.some((item) => item.question?.state === "pending")) throw new Error("A question is already pending.");
            const message = this.messages.find((item) => item.id === id)!;
            message.question = { ...question, id: randomUUID(), state: "pending", resume, work: structuredClone(job.work) };
            this.changed(message); await this.persist();
          }),
          finish: async (id) => { const message = this.messages.find((item) => item.id === id)!; message.state = signal.aborted ? "interrupted" : "complete"; this.changed(message); await this.persist(); },
          claimSave: async () => {
            if (signal.aborted || active.saveAttempted || !job.context.assistantMaySave || this.storageError) return false;
            active.saveAttempted = true; this.state(); await this.persist(); return !signal.aborted;
          },
        });
        signal.throwIfAborted();
      } catch (error) {
        this.cancelQuestions();
        for (const message of this.messages.filter((item) => item.roundId === active.id && item.state === "streaming")) {
          message.state = signal.aborted ? "interrupted" : "error";
          for (const tool of message.tools) if (tool.state === "running") { tool.state = "uncertain"; tool.summary = "No confirmed result. Inspect saved state before another edit."; }
          this.changed(message);
        }
        this.notice(error instanceof RoomWorkStoppedError && !signal.aborted ? error.message : signal.aborted ? active.saveAttempted
          ? "Exchange interrupted. A started save may still have completed; check its result and the saved document. No work is replayed."
          : "Exchange interrupted. This exchange did not attempt a save; no work is replayed."
          : "A collaborator could not finish. Check the actual interaction results before another edit; nothing retries automatically.");
      } finally {
        this.active = null; this.controller = undefined; this.state();
        try { await this.persist(); } catch { /* Persist failure already stops subsequent work. */ }
      }
    }
  }
}
