import * as Automerge from "@automerge/automerge";
import { describe, expect, it } from "vitest";
import { captureAutomerge } from "@foxworth/boundary/automerge";

describe("captureAutomerge", () => {
  it("reads the captured version after the live document changes or is freed", async () => {
    let live = Automerge.from({ count: 1, nested: { label: "captured" } });
    const capture = captureAutomerge(live);
    const originalHeads = [...capture.heads];

    live = Automerge.change(live, (draft) => {
      draft.count = 2;
      draft.nested.label = "live";
    });
    expect(capture.heads).toEqual(originalHeads);
    Automerge.free(live);

    const result = await capture.read((doc) => ({ nested: { label: doc.nested.label } }));
    expect(result).toEqual({ nested: { label: "captured" } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.heads)).toBe(true);
  });

  it("captures a historical view's advertised frontier", async () => {
    const initial = Automerge.from({ count: 1 });
    const initialHeads = Automerge.getHeads(initial);
    const current = Automerge.change(initial, (draft) => {
      draft.count = 2;
    });
    const historical = Automerge.view(current, initialHeads);
    const capture = captureAutomerge(historical);
    const later = Automerge.change(current, (draft) => {
      draft.count = 3;
    });
    expect(later.count).toBe(3);

    const encoded = Automerge.load<{ count: number }>(capture.encode());
    expect(capture.heads).toEqual(initialHeads);
    expect(Automerge.getHeads(encoded)).toEqual(capture.heads);
    expect(encoded.count).toBe(1);
    await expect(capture.read((doc) => doc.count)).resolves.toBe(1);

    Automerge.free(encoded);
  });

  it("captures an older document handle before later changes", () => {
    const older = Automerge.from({ count: 1 });
    const capture = captureAutomerge(older);
    let current = Automerge.change(older, (draft) => {
      draft.count = 2;
    });
    current = Automerge.change(current, (draft) => {
      draft.count = 3;
    });
    expect(current.count).toBe(3);

    const encoded = Automerge.load<{ count: number }>(capture.encode());
    expect(encoded.count).toBe(1);
    expect(Automerge.getHeads(encoded)).toEqual(capture.heads);
    Automerge.free(encoded);
  });

  it("returns defensive encoded copies and awaits async projections", async () => {
    const live = Automerge.from({ value: "snapshot" });
    const capture = captureAutomerge(live);
    const firstEncoding = capture.encode();
    firstEncoding.fill(0);

    await expect(
      capture.read(async (doc) => {
        await Promise.resolve();
        return { value: doc.value };
      }),
    ).resolves.toEqual({ value: "snapshot" });

    const decoded = Automerge.load<{ value: string }>(capture.encode());
    expect(decoded.value).toBe("snapshot");
    Automerge.free(decoded);
    Automerge.free(live);
  });

  it("isolates projector changes and keeps concurrent reads independent", async () => {
    const live = Automerge.from({ value: "captured" });
    const capture = captureAutomerge(live);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const delayed = capture.read(async (doc) => {
      await firstGate;
      return doc.value;
    });
    const changed = capture.read((doc) => {
      const updated = Automerge.change(doc, (draft) => {
        draft.value = "projector-local";
      });
      return updated.value;
    });

    await expect(changed).resolves.toBe("projector-local");
    releaseFirst();
    await expect(delayed).resolves.toBe("captured");
    await expect(capture.read((doc) => doc.value)).resolves.toBe("captured");
    Automerge.free(live);
  });

  it("normalizes and freezes projected JSON while rejecting unsupported values", async () => {
    const live = Automerge.from({ value: 3 });
    const capture = captureAutomerge(live);
    const result = await capture.read((doc) => ({ nested: [doc.value] }));
    expect(result).toEqual({ nested: [3] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);

    await expect(
      capture.read((() => undefined) as never),
    ).rejects.toThrow(/JSON/);
    await expect(
      capture.read((() => new Date()) as never),
    ).rejects.toThrow(/JSON/);
    Automerge.free(live);
  });

  it("propagates projector failures", async () => {
    const live = Automerge.from({ value: 1 });
    const capture = captureAutomerge(live);
    const failure = new Error("projection failed");
    await expect(capture.read(() => { throw failure; })).rejects.toBe(failure);
    Automerge.free(live);
  });
});
