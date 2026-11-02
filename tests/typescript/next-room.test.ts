import "./helpers/folio-environment";
import { describe, expect, it, vi } from "vitest";
import { DocumentRoom, type RoomDisk, type RoomDriver } from "../../examples/apps/typescript/document-workspace/lib/room-store";
import { applyRoomEvent } from "../../examples/apps/typescript/document-workspace/app/use-room";
import { roomContext } from "../../examples/apps/typescript/document-workspace/lib/room-driver";
import type { RoomEvent, RoomInput } from "../../examples/apps/typescript/document-workspace/lib/room-types";

const alice = { session: "alice", canEdit: true, documentId: "doc-1" } as const;
const bob = { session: "bob", canEdit: false, documentId: "doc-1" } as const;
const input = (id: string, text = "Help us think", allowSave = false): RoomInput => ({ id, text, model: "local", allowSave });
function deferred() { let resolve!: () => void; return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() }; }
function persistence(initial?: RoomDisk) {
  let disk = initial;
  return { read: async () => disk ? structuredClone(disk) : undefined, write: vi.fn(async (next: RoomDisk) => { disk = structuredClone(next); }) };
}

describe("Folio's application-owned shared room", () => {
  it("resets all viewers and persisted context without replaying old accepted IDs", async () => {
    const disk = persistence(); const room = await DocumentRoom.open(disk);
    const run = vi.fn<RoomDriver>(async (turn) => { const id = await turn.begin("scout"); turn.text(id, "Old conversation"); await turn.finish(id); });
    await room.submit(alice, input("old")); await room.work(run);
    let viewer = room.snapshot(); room.subscribe((event) => { viewer = applyRoomEvent(viewer, event); });
    expect(await room.reset()).toBe("reset");
    expect(viewer.messages).toEqual([]); expect(room.snapshot().messages).toEqual([]);
    const reopened = await DocumentRoom.open(disk);
    expect(reopened.snapshot().messages).toEqual([]);
    expect(await reopened.submit(alice, input("old"))).toEqual({ duplicate: true });
    await reopened.work(run); expect(run).toHaveBeenCalledTimes(1);
    await reopened.submit(alice, input("new"));
    await reopened.work(async (turn) => { expect(turn.history().map((message) => message.id)).toEqual(["new"]); expect(await turn.claimSave()).toBe(false); });
  });
  it("refuses reset while queued or active work could still publish results", async () => {
    const room = await DocumentRoom.open(persistence()); const entered = deferred(); const settle = deferred();
    await room.submit(alice, input("a")); expect(await room.reset()).toBe("busy");
    const work = room.work(async () => { entered.resolve(); await settle.promise; });
    await entered.promise; expect(await room.reset()).toBe("busy");
    settle.resolve(); await work; expect(await room.reset()).toBe("reset");
  });
  it("retains visible evidence when an actual save result is uncertain", async () => {
    const room = await DocumentRoom.open(persistence()); await room.submit(alice, input("a", "Edit", true));
    await room.work(async (turn) => { const id = await turn.begin("editor"); await turn.tool(id, { id: "t", interaction: "documents.save", state: "uncertain", summary: "Inspect saved state." }); await turn.finish(id); });
    expect(await room.reset()).toBe("uncertain"); expect(room.snapshot().messages).toHaveLength(2);
  });
  it("keeps the old conversation if reset persistence fails", async () => {
    const disk = persistence(); const room = await DocumentRoom.open(disk);
    await room.submit(alice, input("a")); await room.work(async () => {});
    disk.write.mockRejectedValue(new Error("disk unavailable"));
    await expect(room.reset()).rejects.toThrow("Reset persistence failed");
    expect(room.snapshot().messages[0]?.id).toBe("a");
    expect((await disk.read())?.messages[0]?.id).toBe("a");
  });
  it("starts a new message budget after reset without forgetting deduplication", async () => {
    const room = await DocumentRoom.open(persistence());
    for (let index = 0; index < 100; index++) { await room.submit(alice, input(String(index))); await room.work(async () => {}); }
    await expect(room.submit(alice, input("next"))).rejects.toThrow("100-message");
    expect(await room.reset()).toBe("reset");
    expect(await room.submit(alice, input("next"))).toEqual({ duplicate: false });
  });
  it("persists both humans and distinct agent replies; reconnecting does not start work", async () => {
    const disk = persistence(); const room = await DocumentRoom.open(disk);
    await room.submit(alice, input("a"));
    await room.work(async (turn) => {
      const scout = await turn.begin("scout"); turn.text(scout, "Ask who this is for."); await turn.finish(scout);
      const editor = await turn.begin("editor");
      expect(roomContext(turn.history()).some((message) => message.content.includes("scout: Ask who"))).toBe(true);
      turn.text(editor, "I can make that concrete."); await turn.finish(editor);
    });
    await room.submit(bob, input("b", "First-time developers.")); await room.work(async () => {});
    const reopened = await DocumentRoom.open(disk);
    expect(reopened.snapshot().messages.map((message) => message.author)).toEqual(["alice", "scout", "editor", "bob"]);
    expect(reopened.snapshot().active).toBeNull();
  });
  it("does not accept a blanket save allowance from an ordinary message", async () => {
    const room = await DocumentRoom.open(persistence());
    await room.submit(alice, input("a", "Please edit", true));
    await room.work(async (turn) => {
      expect(await turn.claimSave()).toBe(false);
      expect(await turn.claimSave()).toBe(false);
    });
    await room.submit(bob, input("b", "Also edit", true));
    await room.work(async (turn) => { expect(turn.context.assistantMaySave).toBe(false); expect(await turn.claimSave()).toBe(false); });
  });
  it("does not replay an accepted request id, including after restart", async () => {
    const disk = persistence(); const room = await DocumentRoom.open(disk); const run = vi.fn<RoomDriver>(async () => {});
    await room.submit(alice, input("a")); await room.work(run);
    expect(await room.submit(alice, input("a"))).toEqual({ duplicate: true }); await room.work(run);
    expect(run).toHaveBeenCalledTimes(1);
    const reopened = await DocumentRoom.open(disk);
    expect(await reopened.submit(alice, input("a"))).toEqual({ duplicate: true }); await reopened.work(run);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(reopened.submit(bob, input("a"))).rejects.toThrow("message id");
    await expect(reopened.submit(alice, input("a", "different"))).rejects.toThrow("message id");
  });
  it("interrupts on a new human message but settles old work before the next exchange", async () => {
    const room = await DocumentRoom.open(persistence()); const entered = deferred(); const settle = deferred(); const order: string[] = [];
    await room.submit(alice, input("a", "Edit", true));
    const run = room.work(async (turn) => {
      order.push(turn.input.id);
      if (turn.input.id === "a") { const id = await turn.begin("editor"); turn.text(id, "Starting"); entered.resolve(); await settle.promise; expect(turn.signal.aborted).toBe(true); expect(await turn.claimSave()).toBe(false); }
    });
    await entered.promise;
    await room.submit(bob, input("b", "Wait, just discuss."));
    expect(order).toEqual(["a"]); expect(room.snapshot().active?.phase).toBe("stopping");
    settle.resolve(); await run;
    expect(order).toEqual(["a", "b"]);
    expect(room.snapshot().messages.find((message) => message.author === "editor")?.state).toBe("interrupted");
    expect(room.snapshot().active).toBeNull();
    expect(room.snapshot().messages.at(-1)?.text).toContain("did not attempt a save");
  });
  it("keeps newer human context but never runs superseded queued grants", async () => {
    const room = await DocumentRoom.open(persistence()); const run = vi.fn<RoomDriver>(async () => {});
    await room.submit(alice, input("a", "Edit", true));
    await room.submit(bob, input("b", "Only discuss")); await room.work(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].context.assistantMaySave).toBe(false);
    expect(room.snapshot().messages[0]?.state).toBe("interrupted");
  });
  it("stops pending work without executing it", async () => {
    const room = await DocumentRoom.open(persistence()); const run = vi.fn<RoomDriver>(async () => {});
    await room.submit(alice, input("a", "Edit", true)); await room.stop(); await room.work(run);
    expect(run).not.toHaveBeenCalled(); expect(room.snapshot().messages[0]?.state).toBe("interrupted");
  });
  it("recovers an interrupted save as uncertain and never replays it", async () => {
    const disk = persistence({ version: 7, requests: { a: "accepted" }, active: { id: "a", speaker: "editor", phase: "responding", saveAttempted: true },
      messages: [{ id: "m", author: "editor", text: "Working", time: "now", roundId: "a", state: "streaming", tools: [{ id: "t", interaction: "documents.save", state: "running", summary: "Saving" }] }] });
    const room = await DocumentRoom.open(disk); const run = vi.fn<RoomDriver>(async () => {}); await room.work(run);
    expect(run).not.toHaveBeenCalled(); expect(room.snapshot().messages[0]?.tools[0]?.state).toBe("uncertain");
    expect(room.snapshot().messages[0]?.state).toBe("interrupted"); expect(room.snapshot().active).toBeNull();
  });
  it("fails closed when message persistence cannot be confirmed", async () => {
    const disk = persistence(); disk.write.mockRejectedValue(new Error("disk unavailable"));
    const room = await DocumentRoom.open(disk); const run = vi.fn<RoomDriver>(async () => {});
    await expect(room.submit(alice, input("a", "Save", true))).rejects.toThrow(); await room.work(run);
    expect(run).not.toHaveBeenCalled(); expect(room.snapshot().storageError).toContain("storage");
  });
  it("does not clear a recorded storage failure just because the process restarted", async () => {
    const room = await DocumentRoom.open(persistence({ version: 1, requests: {}, messages: [], active: null, storageError: "Room storage needs inspection." }));
    await expect(room.submit(alice, input("a"))).rejects.toThrow("inspection");
  });
  it("bounds model context and preserves the latest human message", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({ id: String(index), author: "alice" as const, text: `${index}: ${"word ".repeat(500)}`, time: "now", state: "complete" as const, tools: [] }));
    const history = roomContext(messages);
    expect(history.length).toBeLessThanOrEqual(24);
    expect(history.at(-1)?.content).toContain("39:");
    expect(history.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(22000);
  });
  it("broadcasts deltas to multiple viewers and restores a reconnect snapshot", async () => {
    const room = await DocumentRoom.open(persistence()); const events: RoomEvent[] = []; const second = vi.fn();
    room.subscribe((event) => events.push(event)); const unsubscribe = room.subscribe(second);
    let view = room.snapshot();
    await room.submit(alice, input("a"));
    await room.work(async (turn) => { const id = await turn.begin("scout"); turn.text(id, "Hello "); turn.text(id, "room"); await turn.finish(id); });
    for (const event of events) view = applyRoomEvent(view, event);
    expect(view).toEqual(room.snapshot()); expect(second).toHaveBeenCalled();
    unsubscribe(); const count = second.mock.calls.length;
    await room.submit(bob, input("b")); expect(second.mock.calls.length).toBe(count);
    expect(applyRoomEvent(view, { type: "snapshot", snapshot: room.snapshot() })).toEqual(room.snapshot());
  });
});
