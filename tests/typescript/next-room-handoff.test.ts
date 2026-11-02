import "./helpers/folio-environment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamText } from "../../examples/apps/typescript/document-workspace/node_modules/ai";
import { DocumentRoom, type RoomDisk } from "../../examples/apps/typescript/document-workspace/lib/room-store";
import { roomDiskSchema } from "../../examples/apps/typescript/document-workspace/lib/room";
import { documentRoomDriver } from "../../examples/apps/typescript/document-workspace/lib/room-driver";
import { addressedParticipants } from "../../examples/apps/typescript/document-workspace/lib/room-addressing";
import { DocumentConflictError, saveDocument } from "../../examples/apps/typescript/document-workspace/lib/documents";
import { parseRichText } from "../../examples/apps/typescript/document-workspace/lib/rich-text";

type Step = { tool?: string; input?: Record<string, unknown>; text?: string };
const model = vi.hoisted(() => ({ steps: [] as Step[], route: "scout", revision: 8 }));
vi.mock("../../examples/apps/typescript/document-workspace/node_modules/ai", async (original) => ({
  ...await original<typeof import("../../examples/apps/typescript/document-workspace/node_modules/ai")>(),
  generateText: vi.fn(async () => ({ text: model.route })),
  streamText: vi.fn(() => {
    const step = model.steps.shift() ?? { tool: "complete_work", input: { result: "The review is complete: this draft makes the audience and next action clear." } };
    const input = step.input ?? {};
    const action = ({ ask_human: "ask", invite_colleague: "handoff", draft_document: "draft", complete_work: "complete" } as Record<string, string>)[step.tool ?? ""];
    return {
      fullStream: (async function* () {})(),
      output: Promise.resolve(action ? { action, text: input.prompt ?? input.reason ?? input.result ?? "Here is the actual draft.",
        kind: input.kind ?? "text", options: input.options ?? [], colleague: input.colleague ?? "editor",
        title: input.title ?? "", bodyLines: input.bodyLines ?? (typeof input.body === "string" ? input.body.split("\n") : []) } : {}),
      finishReason: Promise.resolve("stop"),
    };
  }),
}));
vi.mock("../../examples/apps/typescript/document-workspace/lib/ollama", () => ({ ollamaModel: () => ({}) }));
vi.mock("../../examples/apps/typescript/document-workspace/lib/documents", async (original) => ({
  ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/documents")>(),
  readDocument: vi.fn(async () => ({ id: "doc-1", title: "Launch brief", body: "Original body", revision: model.revision })),
  saveDocument: vi.fn(),
}));
vi.mock("../../examples/apps/typescript/document-workspace/lib/activity", async (original) => ({ ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/activity")>(), recordActivity: vi.fn(), recordObservation: vi.fn() }));

const alice = { session: "alice", documentId: "doc-1", canEdit: true } as const;
const bob = { session: "bob", documentId: "doc-1", canEdit: false } as const;
const driver = () => documentRoomDriver(vi.fn());
const invite: Step = { tool: "invite_colleague", input: { colleague: "editor", reason: "Draft the customer's launch brief." } };
const draft: Step = { tool: "draft_document", input: { title: "Customer launch", body: "Our new product helps customers launch with confidence." } };
const ask = (kind = "choice", options = ["Customers", "Internal team"]): Step => ({ tool: "ask_human", input: { kind, prompt: "Who is this for?", options } });
async function roomWith(text = "Scout, help us write a launch brief.", steps: Step[] = []) {
  model.steps.push(...steps);
  let disk: RoomDisk | undefined;
  const persistence = { read: async () => disk ? roomDiskSchema.parse(JSON.parse(JSON.stringify(disk))) : undefined, write: async (next: RoomDisk) => { disk = structuredClone(next); } };
  const room = await DocumentRoom.open(persistence);
  await room.submit(alice, { id: "first", text, model: "fixture", allowSave: true });
  await room.work(driver());
  return { room, persistence };
}
function pending(room: DocumentRoom) { return room.snapshot().messages.findLast((message) => message.question?.state === "pending")!.question!; }
const answerInput = (questionId: string, value: string, id = "answer") => ({ id, text: value, model: "untrusted-model-is-ignored", allowSave: true, answer: { questionId, value } });
beforeEach(() => {
  vi.clearAllMocks(); model.steps = []; model.route = "scout"; model.revision = 8;
  vi.mocked(saveDocument).mockImplementation(async (input) => {
    if (input.expectedRevision !== model.revision) throw new DocumentConflictError(model.revision);
    return { id: "doc-1", title: input.title, body: input.body, revision: ++model.revision };
  });
});

describe("room work, human questions and exact-draft approval", () => {
  it("preserves Markdown blocks through draft, persisted approval and the exact save payload", async () => {
    const { persistence } = await roomWith("Editor, format the brief.", [{ tool: "draft_document", input: {
      title: "Launch", body: "## Audience\n\nThe **internal** team.\n\n1. Review the API\n2. Approve the launch", bodyLines: ["## Audience", "", "The **internal** team.", "", "1. Review the API", "2. Approve the launch"],
    } }]);
    const reopened = await DocumentRoom.open(persistence);
    const approval = pending(reopened);
    const proposed = approval.work.draft!;
    const parsed = parseRichText(proposed.richText ?? "");
    expect(parsed?.json.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "orderedList"]);
    expect(parsed?.body).toBe(proposed.body);
    expect(proposed.body).not.toContain("**");
    expect(saveDocument).not.toHaveBeenCalled();
    await reopened.submit(alice, answerInput(approval.id, "Apply")); await reopened.work(driver());
    const { id: _id, ...content } = proposed;
    expect(saveDocument).toHaveBeenCalledExactlyOnceWith({ ...content, id: "doc-1" });
  });
  it("pauses both participants, resumes the same goal, drafts, reviews and applies once without another model call", async () => {
    const { room, persistence } = await roomWith("Scout and Editor: help draft a brief.", [ask()]);
    expect(streamText).toHaveBeenCalledTimes(1); expect(saveDocument).not.toHaveBeenCalled();
    const question = pending(room);
    expect(question.options).toEqual(["Customers", "Internal team"]);
    const reopened = await DocumentRoom.open(persistence);
    expect(pending(reopened).id).toBe(question.id);
    model.steps.push(invite, draft);
    await reopened.submit(alice, answerInput(question.id, "Customers")); await reopened.work(driver());
    expect(vi.mocked(streamText).mock.calls[1]?.[0].system).toContain("Scout and Editor: help draft a brief.");
    expect(vi.mocked(streamText).mock.calls[1]?.[0].system).toContain("Customers");
    expect(reopened.snapshot().messages.filter((message) => message.roundId).map((message) => message.author)).toEqual(["scout", "scout", "editor", "scout"]);
    const approval = pending(reopened); expect(approval.kind).toBe("approval");
    expect(approval.work.draft?.expectedRevision).toBe(8); expect(saveDocument).not.toHaveBeenCalled();
    const before = vi.mocked(streamText).mock.calls.length;
    const input = answerInput(approval.id, "Apply", "apply");
    await reopened.submit(alice, input); await reopened.work(driver());
    expect(saveDocument).toHaveBeenCalledExactlyOnceWith({ id: "doc-1", title: "Customer launch", body: "Our new product helps customers launch with confidence.", richText: approval.work.draft?.richText, expectedRevision: 8 });
    expect(streamText).toHaveBeenCalledTimes(before);
    expect(await reopened.submit(alice, input)).toEqual({ duplicate: true }); await reopened.work(driver());
    await expect(reopened.submit(alice, { ...input, id: "second-apply" })).rejects.toThrow("no longer pending");
    expect(saveDocument).toHaveBeenCalledTimes(1);
  });
  it.each(["boolean", "text", "choice"])("accepts a %s question and a free-text answer without save authority", async (kind) => {
    const { room } = await roomWith(undefined, [ask(kind)]);
    const question = pending(room);
    expect(question.options).toEqual(kind === "boolean" ? ["Yes", "No"] : kind === "text" ? [] : ["Customers", "Internal team"]);
    await room.submit(alice, answerInput(question.id, "Actually, prospective customers in small businesses"));
    await room.work(async (turn) => {
      expect(turn.work.id).toBe("first"); expect(turn.resume).toBe("scout");
      expect(turn.input.model).toBe("fixture"); expect(turn.context.assistantMaySave).toBe(false);
      expect(await turn.claimSave()).toBe(false);
    });
  });
  it("rejects other participants, empty answers and unbound approval text", async () => {
    const { room } = await roomWith(undefined, [ask()]); const question = pending(room);
    await expect(room.submit(bob, answerInput(question.id, "Customers"))).rejects.toThrow("other participant");
    await expect(room.submit(alice, answerInput(question.id, " "))).rejects.toThrow("needs an answer");
    await room.submit(alice, { id: "unbound", text: "yes apply it", model: "fixture", allowSave: true });
    await room.work(async (turn) => { expect(await turn.claimSave()).toBe(false); });
    expect(room.snapshot().messages.find((message) => message.question)?.question?.state).toBe("cancelled");
    await expect(room.submit(alice, answerInput(question.id, "Customers"))).rejects.toThrow("no longer pending");
  });
  it("one question step suspends all queued collaborators", async () => {
    const { room } = await roomWith("Scout and Editor: draft together.", [ask()]);
    expect(pending(room).kind).toBe("choice"); expect(streamText).toHaveBeenCalledTimes(1);
  });
  it("continues an intention-only reply to a real draft instead of stopping", async () => {
    const { room } = await roomWith("Editor, write this brief.", [{ text: "I will draft this content now." }, draft]);
    expect(room.snapshot().messages.some((message) => message.draft?.body.includes("customers"))).toBe(true);
    expect(pending(room).kind).toBe("approval"); expect(saveDocument).not.toHaveBeenCalled();
  });
  it("reports no progress visibly after two empty actions, without looping forever", async () => {
    const { room } = await roomWith("Editor, write this brief.", [{ text: "I will draft now." }, { text: "I will do it." }]);
    expect(streamText).toHaveBeenCalledTimes(2);
    expect(room.snapshot().messages.some((message) => message.state === "error")).toBe(true);
    expect(room.snapshot().messages.some((message) => message.question)).toBe(false);
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("allows Editor → Scout → Editor → Scout with a revised concrete draft", async () => {
    const { room } = await roomWith("Editor, draft it.", [draft, invite, { ...draft, input: { title: "Revised", body: "A clearer customer benefit." } }]);
    expect(room.snapshot().messages.filter((message) => message.roundId).map((message) => message.author)).toEqual(["editor", "scout", "editor", "scout"]);
    expect(pending(room).work.draft?.title).toBe("Revised");
  });
  it("bounds repeated handoffs", async () => {
    const steps = Array.from({ length: 10 }, (_, index) => ({ tool: "invite_colleague", input: { colleague: index % 2 === 0 ? "editor" : "scout", reason: "Review again." } }));
    const { room } = await roomWith(undefined, steps);
    expect(streamText).toHaveBeenCalledTimes(8); expect(room.snapshot().messages.at(-1)?.author).toBe("room");
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("keeps a draft without saving or running inference", async () => {
    const { room } = await roomWith("Editor, draft.", [draft]); const question = pending(room);
    await room.submit(alice, answerInput(question.id, "Keep as draft")); await room.work(driver());
    expect(saveDocument).not.toHaveBeenCalled(); expect(streamText).toHaveBeenCalledTimes(2);
    expect(room.snapshot().messages.at(-1)?.text).toContain("unchanged");
  });
  it("rechecks edit permission and never interprets a generic yes as approval", async () => {
    const { room } = await roomWith("Editor, draft.", [draft]); const question = pending(room);
    await expect(room.submit({ ...alice, canEdit: false }, answerInput(question.id, "Apply"))).rejects.toThrow("cannot authorize");
    await expect(room.submit(alice, answerInput(question.id, "Yes"))).rejects.toThrow("Apply or Keep");
    expect(pending(room).id).toBe(question.id); expect(saveDocument).not.toHaveBeenCalled();
  });
  it("retains the draft through a reviewer question and resumes review, not new unrelated work", async () => {
    const { room } = await roomWith("Editor, draft.", [draft, ask("boolean")]);
    const question = pending(room); expect(question.work.draft?.title).toBe("Customer launch");
    await room.submit(alice, answerInput(question.id, "Yes")); await room.work(driver());
    expect(pending(room).kind).toBe("approval");
    expect(pending(room).work.draft?.id).toBe(question.work.draft?.id);
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it("serializes simultaneous answers so only one resumes the work", async () => {
    const { room } = await roomWith(undefined, [ask()]); const question = pending(room);
    const answers = await Promise.allSettled([room.submit(alice, answerInput(question.id, "Customers", "one")), room.submit(alice, answerInput(question.id, "Internal team", "two"))]);
    expect(answers.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const run = vi.fn(); await room.work(run); expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not silently rebase or retry an approved stale revision", async () => {
    const { room } = await roomWith("Editor, draft.", [draft]); model.revision = 9;
    await room.submit(alice, answerInput(pending(room).id, "Apply")); await room.work(driver());
    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(room.snapshot().messages.at(-1)?.tools[0]?.state).toBe("conflict");
    expect(model.revision).toBe(9);
  });
  it("retains an uncertain effect and refuses reset rather than retrying", async () => {
    const { room } = await roomWith("Editor, draft.", [draft]);
    vi.mocked(saveDocument).mockRejectedValueOnce(new Error("outcome lost"));
    await room.submit(alice, answerInput(pending(room).id, "Apply")); await room.work(driver());
    expect(room.snapshot().messages.at(-1)?.tools[0]?.state).toBe("uncertain");
    expect(await room.reset()).toBe("uncertain"); expect(saveDocument).toHaveBeenCalledTimes(1);
  });
  it("invalidates a paused question on Stop or Reset", async () => {
    const { room } = await roomWith(undefined, [ask()]); const question = pending(room);
    await room.stop(); await expect(room.submit(alice, answerInput(question.id, "Customers"))).rejects.toThrow("no longer pending");
    expect(await room.reset()).toBe("reset"); expect(room.snapshot().messages).toEqual([]);
  });
  it("does not expose a save tool to either model", async () => {
    await roomWith(undefined, [invite, draft]);
    for (const [options] of vi.mocked(streamText).mock.calls) expect(options.tools ?? {}).not.toHaveProperty("save_document");
  });
  it.each(["Editor, help.", "@Editor, can you help?", "Please invite Editor", "Can you ask Editor to respond?"])("routes an explicit address directly: %s", async (text) => {
    const { room } = await roomWith(text);
    expect(room.snapshot().messages.find((message) => message.roundId)?.author).toBe("editor");
  });
  it("does not route ordinary mentions, negations or quoted addresses", () => {
    expect(addressedParticipants("Editor is a collaborator.")).toEqual([]);
    expect(addressedParticipants('Write the literal phrase "invite Editor".')).toEqual([]);
    expect(addressedParticipants("Don't invite Editor.")).toEqual([]);
    expect(addressedParticipants("Editor and Scout: discuss this.")).toEqual(["editor", "scout"]);
  });
});
