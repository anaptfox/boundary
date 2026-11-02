import { describe, expect, it, vi } from "vitest";
import { WebSocketRoom, type RoomSink } from "../../examples/apps/typescript/websocket-room/room";
import { agentStream } from "../../examples/apps/typescript/websocket-room/agent";
import { createRoomHost } from "../../examples/apps/typescript/websocket-room/host";
import type { UIMessage, WebSocketChatTransportResponse, UIMessageChunk } from "../../examples/apps/typescript/websocket-room/node_modules/ai";
const message = (text = "complete 1"): UIMessage => ({ id: "message-1", role: "user", parts: [{ type: "text", text }] });
const frame = (id = "chat-1", requestId = "request-1") => ({ type: "send", id, requestId, trigger: "submit-message", headers: {}, body: {}, messageId: "message-1", messages: [message()] });
function receiver() { const frames: WebSocketChatTransportResponse[] = []; const sink: RoomSink = { send(value) { frames.push(value); return true; } }; return { frames, sink }; }

describe("host-owned WebSocket room", () => {
  it("searches selected tools, checkpoints steps, and proposes without performing an effect", async () => {
    const host = await createRoomHost(); const checkpoints: UIMessage[] = [];
    const chunks = [];
    for await (const chunk of await agentStream(host, [message()], new AbortController().signal, (value) => checkpoints.push(value))) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.type === "tool-input-available" && chunk.toolName === "tool_search")).toBe(true);
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(host.snapshot().todos[0]?.completed).toBe(false);
    const proposal = host.snapshot().proposals[0]!; expect(proposal.state).toBe("pending");
    const [a, b] = await Promise.all([host.approve(proposal.id), host.approve(proposal.id)]);
    expect(a.state).toBe("completed"); expect(["executing", "completed"]).toContain(b.state);
    expect(host.snapshot().todos[0]?.completed).toBe(true);
    expect((await host.approve(proposal.id)).state).toBe("completed");
  });
  it("rejects a proposal when the exact observed todo has changed", async () => {
    const host = await createRoomHost(); const a = host.propose(1); const b = host.propose(1);
    await host.approve(a.id); expect((await host.approve(b.id)).state).toBe("stale");
  });
  it("deduplicates accepted message ids and reconnects through replay without invoking again", async () => {
    const drive = vi.fn(async function* (_messages: UIMessage[], _signal: AbortSignal, _checkpoint: (message: UIMessage) => void) { yield { type: "start", messageId: "reply" } as UIMessageChunk; yield { type: "finish" } as UIMessageChunk; });
    const room = new WebSocketRoom(async (...args) => drive(...args)); const first = receiver();
    try {
      await room.receive(frame(), first.sink); await vi.waitFor(() => expect(first.frames.at(-1)?.type).toBe("end"));
      room.disconnect(first.sink); const replay = receiver();
      await room.receive({ type: "resume", headers: {}, body: {}, id: "chat-1", requestId: "resume-1" }, replay.sink);
      expect(replay.frames.map((entry) => entry.type)).toEqual(["start", "chunk", "chunk", "end"]);
      expect(replay.frames.filter((entry) => entry.type === "chunk").map((entry) => entry.sequence)).toEqual([0, 1]);
      await room.receive(frame("chat-1", "duplicate"), replay.sink); expect(drive).toHaveBeenCalledTimes(1);
      await expect(room.receive({ ...frame(), messages: [message("different content")] }, replay.sink)).rejects.toThrow("different content");
    } finally { room.close(); }
  });
  it("keeps concurrent chats separate and only lets a subscribed request cancel its job", async () => {
    const signals = new Map<string, AbortSignal>();
    const room = new WebSocketRoom(async function* (messages, signal): AsyncGenerator<UIMessageChunk> {
      signals.set(messages[0]!.id, signal);
      yield { type: "start", messageId: messages[0]!.id };
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
    });
    const first = receiver(); const second = receiver();
    try {
      await room.receive(frame(), first.sink);
      await room.receive({ ...frame("chat-2", "request-2"), messages: [{ ...message(), id: "message-2" }] }, second.sink);
      await vi.waitFor(() => expect(signals.size).toBe(2));
      await room.receive({ type: "abort", requestId: "request-1" }, second.sink); expect(signals.get("message-1")?.aborted).toBe(false);
      await room.receive({ type: "abort", requestId: "request-1" }, first.sink);
      await vi.waitFor(() => expect(first.frames.at(-1)?.type).toBe("error"));
      expect(signals.get("message-2")?.aborted).toBe(false);
    } finally { room.close(); }
  });
  it("drops slow subscribers and bounds the retained reply", async () => {
    const room = new WebSocketRoom(async function* (): AsyncGenerator<UIMessageChunk> { for (let i = 0; i < 300; i++) yield { type: "text-delta", id: "text", delta: "x" }; });
    let sent = 0; const slow: RoomSink = { send() { return ++sent < 3; } };
    const observer = receiver();
    try {
      await room.receive(frame(), slow); await room.receive({ type: "resume", headers: {}, body: {}, id: "chat-1", requestId: "observer" }, observer.sink);
      await vi.waitFor(() => expect(observer.frames.at(-1)?.type).toBe("error"));
      expect(sent).toBe(3); expect(observer.frames.filter((entry) => entry.type === "chunk")).toHaveLength(256);
    } finally { room.close(); }
  });
  it("has no resumable work after process restart", async () => {
    const room = new WebSocketRoom(async function* () {}); const receiverState = receiver();
    await room.receive({ type: "resume", headers: {}, body: {}, id: "previous-process", requestId: "resume" }, receiverState.sink);
    expect(receiverState.frames).toEqual([{ type: "no-active", requestId: "resume" }]); room.close();
  });
});
