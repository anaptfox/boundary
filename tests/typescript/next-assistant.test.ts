import "./helpers/folio-environment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentTools } from "../../examples/apps/typescript/document-workspace/lib/assistant-tools";
import { demoContextFromCookie } from "../../examples/apps/typescript/document-workspace/lib/context";
import { readDocument, saveDocument, DocumentConflictError } from "../../examples/apps/typescript/document-workspace/lib/documents";
import { recordActivity, recordObservation } from "../../examples/apps/typescript/document-workspace/lib/activity";
import { POST as probe } from "../../examples/apps/typescript/document-workspace/app/api/probe/route";
import { boundedJson, requestContext } from "../../examples/apps/typescript/document-workspace/lib/demo-request";
import { localModels, ollamaUrl } from "../../examples/apps/typescript/document-workspace/lib/ollama";

vi.mock("../../examples/apps/typescript/document-workspace/lib/documents", async (original) => ({ ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/documents")>(), readDocument: vi.fn(), saveDocument: vi.fn() }));
vi.mock("../../examples/apps/typescript/document-workspace/lib/activity", async (original) => ({ ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/activity")>(), recordActivity: vi.fn(), recordObservation: vi.fn() }));
const current = { id: "doc-1", title: "Launch brief", body: "A clear starting point.", revision: 7, richText: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A clear starting point."}]}]}' } as const;
const options = { toolCallId: "test", messages: [], context: {} };
const input = { id: "doc-1", title: "A clearer title", body: current.body, expectedRevision: 7 } as const;
const alice = demoContextFromCookie("boundary_demo_session=alice");
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(readDocument).mockResolvedValue(current); vi.mocked(saveDocument).mockResolvedValue({ ...current, title: input.title, revision: 8 }); });

describe("Folio assistant tools use the real Binding", () => {
  it("reads, saves once, preserves observed formatting, and invalidates after success", async () => {
    const refresh = vi.fn();
    const selected = createDocumentTools(() => ({ ...alice, assistantMaySave: true }), refresh);
    expect(await selected.tools.read_document.execute!({ id: "doc-1" }, options)).toEqual(current);
    expect(await selected.tools.save_document.execute!(input, options)).toEqual({ status: "saved", title: input.title, revision: 8 });
    expect(saveDocument).toHaveBeenCalledWith({ ...input, richText: current.richText });
    expect(await selected.tools.save_document.execute!(input, options)).toMatchObject({ status: "not-started" });
    expect(saveDocument).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ trace: expect.objectContaining({ source: "assistant" }) }), expect.objectContaining({ stage: "refresh" }));
    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({ interactionId: "documents.save", resultKind: "returned", certainty: "completed" }));
  });
  it.each([
    ["Alice without turn consent", { ...alice, assistantMaySave: false }],
    ["Bob even with turn consent", { ...demoContextFromCookie("boundary_demo_session=bob"), assistantMaySave: true }],
  ])("denies %s at host admission", async (_, context) => {
    const refresh = vi.fn(); const selected = createDocumentTools(() => context, refresh);
    expect(await selected.tools.save_document.execute!(input, options)).toEqual({ status: "rejected" });
    expect(saveDocument).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({ resultKind: "denied", certainty: "not-started" }));
  });
  it("returns a typed conflict and does not retry it", async () => {
    vi.mocked(saveDocument).mockRejectedValue(new DocumentConflictError(8));
    const refresh = vi.fn(); const selected = createDocumentTools(() => ({ ...alice, assistantMaySave: true }), refresh);
    expect(await selected.tools.save_document.execute!(input, options)).toEqual({ status: "conflict", actualRevision: 8 });
    expect(await selected.tools.save_document.execute!(input, options)).toMatchObject({ status: "not-started" });
    expect(saveDocument).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
  });
  it("preserves an unknown effect outcome and does not retry", async () => {
    vi.mocked(saveDocument).mockRejectedValue(new Error("storage result unavailable"));
    const selected = createDocumentTools(() => ({ ...alice, assistantMaySave: true }), vi.fn());
    expect(await selected.tools.save_document.execute!(input, options)).toEqual({ status: "uncertain" });
    expect(await selected.tools.save_document.execute!(input, options)).toMatchObject({ status: "not-started" });
    expect(saveDocument).toHaveBeenCalledTimes(1);
  });
  it("does not start a save after cancellation", async () => {
    const selected = createDocumentTools(() => ({ ...alice, assistantMaySave: true }), vi.fn(), AbortSignal.abort());
    expect(await selected.tools.save_document.execute!(input, options)).toMatchObject({ status: "not-started" });
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("enforces Scout's read-only identity even if a save tool is invoked directly", async () => {
    const selected = createDocumentTools(() => ({ ...alice, assistantMaySave: true }), vi.fn(), undefined, "scout");
    expect(await selected.tools.save_document.execute!(input, options)).toEqual({ status: "rejected" });
    expect(saveDocument).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ assistantAgent: "scout" }), expect.objectContaining({ stage: "policy", decision: "deny" }));
  });
});

describe("Folio probes and local request limits", () => {
  const request = (kind: string) => new Request("http://localhost:3000/api/probe", { method: "POST", headers: { cookie: "boundary_demo_session=alice", origin: "http://localhost:3000" }, body: JSON.stringify({ kind }) });
  it("narrows authority for the read-only probe without entering storage", async () => {
    expect(await (await probe(request("denied"))).json()).toMatchObject({ status: "rejected", expectedRevision: 7 });
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("uses a strictly older revision, never a future one", async () => {
    vi.mocked(saveDocument).mockRejectedValue(new DocumentConflictError(7));
    expect(await (await probe(request("stale"))).json()).toMatchObject({ status: "conflict", actualRevision: 7, expectedRevision: 6 });
    expect(saveDocument).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
  });
  it("rejects zero before entering storage at the seed revision", async () => {
    vi.mocked(readDocument).mockResolvedValue({ ...current, revision: 1 });
    expect(await (await probe(request("stale"))).json()).toMatchObject({ status: "rejected", expectedRevision: 0 });
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests and oversized bodies", async () => {
    expect(() => requestContext(new Request("http://localhost:3000/api/assistant", { method: "POST", headers: { origin: "https://elsewhere.example", cookie: "boundary_demo_session=alice" } }))).toThrow("same-origin");
    await expect(boundedJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ prompt: "x".repeat(33000) }) }))).rejects.toThrow("too large");
  });
  it("rejects remote provider URLs", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "https://api.example.com"); expect(ollamaUrl).toThrow("loopback");
  });
  it("excludes cloud-backed and explicitly non-tool models", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [
      { name: "llama3.2:3b", capabilities: ["tools"] }, { name: "remote", remote_host: "https://ollama.com" }, { name: "big-cloud" }, { name: "embedding", capabilities: ["embedding"] },
    ] })));
    expect(await localModels()).toEqual({ models: ["llama3.2:3b"], defaultModel: "llama3.2:3b" });
  });
});
