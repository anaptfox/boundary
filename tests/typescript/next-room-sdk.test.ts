import "./helpers/folio-environment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamProviderError } from "../../examples/apps/typescript/document-workspace/node_modules/ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "../../examples/apps/typescript/document-workspace/node_modules/ai/dist/test/index.js";
import { DocumentRoom } from "../../examples/apps/typescript/document-workspace/lib/room-store";
import { documentRoomDriver } from "../../examples/apps/typescript/document-workspace/lib/room-driver";
import { saveDocument } from "../../examples/apps/typescript/document-workspace/lib/documents";

const state = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../../examples/apps/typescript/document-workspace/lib/ollama", () => ({ ollamaModel: () => state.model }));
vi.mock("../../examples/apps/typescript/document-workspace/lib/documents", async (original) => ({
  ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/documents")>(),
  readDocument: vi.fn(async () => ({ id: "doc-1", title: "Brief", body: "Original", revision: 1 })),
  saveDocument: vi.fn(),
}));
vi.mock("../../examples/apps/typescript/document-workspace/lib/activity", async (original) => ({ ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/activity")>(), recordActivity: vi.fn(), recordObservation: vi.fn() }));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const draft = JSON.stringify({ action: "draft", text: "A proposed revision.", kind: "text", options: [], colleague: "scout", title: "Changed", bodyLines: ["A new body."] });
async function editorRoom(model: MockLanguageModelV4) {
  state.model = model;
  const room = await DocumentRoom.open({ read: async () => undefined, write: async () => {} });
  await room.submit({ session: "alice", canEdit: true, documentId: "doc-1" }, { id: "test", text: "Editor, propose a revision.", model: "fixture", allowSave: false });
  return room;
}
beforeEach(() => vi.clearAllMocks());
describe("room work through the real AI SDK stream", () => {
  it("settles a completed action before advancing to the next participant", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "step" },
      { type: "text-delta", id: "step", delta: JSON.stringify({ action: "complete", text: "An actual observation.", kind: "text", options: [], colleague: "editor", title: "", bodyLines: [] }) },
      { type: "text-end", id: "step" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } },
    ]) }) });
    state.model = model;
    const room = await DocumentRoom.open({ read: async () => undefined, write: async () => {} });
    await room.submit({ session: "alice", canEdit: true, documentId: "doc-1" }, { id: "test", text: "Scout and Editor: each give one concrete observation.", model: "fixture", allowSave: false });
    await room.work(documentRoomDriver(vi.fn()));
    expect(room.snapshot().messages.filter((message) => message.roundId).map((message) => [message.author, message.state])).toEqual([["scout", "complete"], ["editor", "complete"]]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.prompt.at(-1)?.role).toBe("user");
    expect(model.doStreamCalls[0]?.responseFormat?.type).toBe("json");
  });

  it.each([draft, draft.slice(0, -20)])("rejects a response limit without proposing or retrying (%#)", async (text) => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "step" },
      { type: "text-delta", id: "step", delta: text }, { type: "text-end", id: "step" },
      { type: "finish", finishReason: { unified: "length", raw: "length" }, usage },
    ]) }) });
    const room = await editorRoom(model);
    await room.work(documentRoomDriver(vi.fn()));
    expect(room.snapshot().messages.some((message) => message.draft || message.question)).toBe(false);
    expect(room.snapshot().messages.at(-1)?.text).toContain("response limit");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("drains a provider error without exposing its payload or promoting partial output", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "step" },
      { type: "text-delta", id: "step", delta: draft },
      { type: "error", error: new StreamProviderError({ message: "private provider detail", statusCode: 503, data: { secret: "private payload" } }) },
      { type: "text-end", id: "step" },
      { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
    ]) }) });
    const room = await editorRoom(model);
    await room.work(documentRoomDriver(vi.fn()));
    expect(room.snapshot().messages.at(-1)?.text).toContain("connection failed while replying");
    expect(JSON.stringify(room.snapshot())).not.toContain("private");
    expect(room.snapshot().messages.some((message) => message.draft || message.question)).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("settles Stop during structured output without publishing a draft or calling another model", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let providerSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }: MockLanguageModelV4["doStreamCalls"][number]) => {
      providerSignal = abortSignal;
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "step" });
        controller.enqueue({ type: "text-delta", id: "step", delta: draft.slice(0, -20) });
        abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), { once: true });
        notifyStarted();
      } }) };
    } });
    const room = await editorRoom(model);
    const work = room.work(documentRoomDriver(vi.fn()));
    await started;
    await room.stop();
    await work;
    expect(providerSignal?.aborted).toBe(true);
    expect(room.snapshot().active).toBeNull();
    expect(room.snapshot().messages.find((message) => message.roundId)?.state).toBe("interrupted");
    expect(room.snapshot().messages.some((message) => message.draft || message.question)).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("cancels a provider stream that reports an error but never closes", async () => {
    const cancelled = vi.fn();
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "step" });
        controller.enqueue({ type: "text-delta", id: "step", delta: draft });
        controller.enqueue({ type: "error", error: new StreamProviderError({ message: "private provider failure", statusCode: 503 }) });
      },
      cancel: cancelled,
    }) }) });
    const room = await editorRoom(model);
    await room.work(documentRoomDriver(vi.fn()));
    expect(cancelled).toHaveBeenCalledOnce();
    expect(room.snapshot().active).toBeNull();
    expect(room.snapshot().messages.at(-1)?.text).toContain("connection failed while replying");
    expect(room.snapshot().messages.some((message) => message.draft || message.question)).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(saveDocument).not.toHaveBeenCalled();
  }, 1000);
});
