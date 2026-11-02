import { safeValidateWebSocketChatTransportRequest, type UIMessage, type UIMessageChunk, type WebSocketChatTransportResponse } from "ai";

export type RoomSink = { send(frame: WebSocketChatTransportResponse): boolean };
export type StreamDriver = (messages: UIMessage[], signal: AbortSignal, checkpoint: (message: UIMessage) => void) => Promise<AsyncIterable<UIMessageChunk>> | AsyncIterable<UIMessageChunk>;
type Subscription = { requestId: string; sink: RoomSink };
type Job = { key: string; fingerprint: string; chunks: UIMessageChunk[]; bytes: number; controller: AbortController; subscriptions: Set<Subscription>; state: "active" | "ended" | "error"; checkpoint?: UIMessage };

/** Host-owned process-local jobs and replay evidence, never an effect dispatcher. */
export class WebSocketRoom {
  private readonly chats = new Map<string, Job>();
  private readonly accepted = new Map<string, Job>();
  private closed = false;
  constructor(private readonly drive: StreamDriver) {}
  checkpoint(chatId: string) { return structuredClone(this.chats.get(chatId)?.checkpoint); }
  disconnect(sink: RoomSink) {
    for (const job of this.chats.values()) for (const sub of job.subscriptions) if (sub.sink === sink) job.subscriptions.delete(sub);
  }
  close() {
    this.closed = true;
    for (const job of this.chats.values()) { job.controller.abort(); job.subscriptions.clear(); }
  }
  async receive(value: unknown, sink: RoomSink): Promise<void> {
    const checked = await safeValidateWebSocketChatTransportRequest({ value });
    if (!checked.success || this.closed) throw new Error("invalid or closed room request");
    const frame = checked.data;
    if (frame.type === "abort") {
      for (const job of this.chats.values()) {
        if ([...job.subscriptions].some((sub) => sub.sink === sink && sub.requestId === frame.requestId)) job.controller.abort();
      }
      return;
    }
    const sub = { requestId: frame.requestId, sink };
    if (frame.type === "resume") {
      const job = this.chats.get(frame.id);
      if (!job) { sink.send({ type: "no-active", requestId: frame.requestId }); return; }
      // The SDK requests complete replay. Sequence values never authorize work.
      this.attach(job, sub);
      return;
    }
    const messageId = frame.messageId ?? frame.messages.at(-1)?.id;
    if (!messageId || frame.messages.length > 50) throw new Error("bounded messages with an id required");
    const key = JSON.stringify([frame.id, messageId]);
    const fingerprint = JSON.stringify(frame.messages);
    const prior = this.accepted.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("message id already accepted with different content");
      this.attach(prior, sub); return;
    }
    if (this.accepted.size >= 256 || (!this.chats.has(frame.id) && this.chats.size >= 64) || [...this.chats.values()].filter((job) => job.state === "active").length >= 8) throw new Error("local room capacity reached");
    if (this.chats.get(frame.id)?.state === "active") throw new Error("chat already has active work");
    const job: Job = { key, fingerprint, chunks: [], bytes: 0, controller: new AbortController(), subscriptions: new Set(), state: "active" };
    this.accepted.set(key, job); this.chats.set(frame.id, job); this.attach(job, sub);
    void this.work(job, frame.messages);
  }
  private attach(job: Job, sub: Subscription) {
    if (!sub.sink.send({ type: "start", requestId: sub.requestId })) return;
    for (const [sequence, chunk] of job.chunks.entries()) if (!sub.sink.send({ type: "chunk", requestId: sub.requestId, sequence, chunk })) return;
    if (job.state === "active") job.subscriptions.add(sub);
    else this.terminal(job, sub);
  }
  private terminal(job: Job, sub: Subscription) {
    sub.sink.send(job.state === "ended" ? { type: "end", requestId: sub.requestId } : { type: "error", requestId: sub.requestId, errorText: "Reply interrupted; no effect was repeated." });
  }
  private async work(job: Job, messages: UIMessage[]) {
    try {
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(60_000)]);
      const stream = await this.drive(messages, signal, (message) => { job.checkpoint = structuredClone(message); });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const bytes = Buffer.byteLength(JSON.stringify(chunk));
        if (job.chunks.length >= 256 || job.bytes + bytes > 512 * 1024) throw new Error("replay capacity reached");
        const sequence = job.chunks.length; job.bytes += bytes; job.chunks.push(chunk);
        for (const sub of job.subscriptions) if (!sub.sink.send({ type: "chunk", requestId: sub.requestId, sequence, chunk })) job.subscriptions.delete(sub);
      }
      signal.throwIfAborted(); job.state = "ended";
    } catch { job.state = "error"; job.controller.abort(); }
    for (const sub of job.subscriptions) this.terminal(job, sub);
    job.subscriptions.clear();
  }
}
