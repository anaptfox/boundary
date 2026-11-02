import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@foxworth/boundary/program";
import { captureYjs } from "@foxworth/boundary/yjs";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("captureYjs", () => {
  it("captures the snapshot delete set even when the state vector is unchanged", async () => {
    const doc = new Y.Doc();
    try {
      const items = doc.getMap<string>("items");
      items.set("gone", "present");
      const stateVector = Y.encodeStateVector(doc);
      const beforeDelete = hex(Y.encodeSnapshot(Y.snapshot(doc)));

      items.delete("gone");
      expect(Y.encodeStateVector(doc)).toEqual(stateVector);
      const captured = captureYjs(doc);
      expect(captured.frontier).toBe(hex(Y.encodeSnapshot(Y.snapshot(doc))));
      expect(captured.frontier).not.toBe(beforeDelete);

      const replica = new Y.Doc();
      try {
        Y.applyUpdate(replica, captured.encode());
        expect(hex(Y.encodeSnapshot(Y.snapshot(replica)))).toBe(captured.frontier);
      } finally {
        replica.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it("reads a captured full state after later edits and isolates byte and JSON copies", async () => {
    const doc = new Y.Doc();
    try {
      expect(doc.gc).toBe(true);
      type Orb = { position: { x: number; y: number }; labels: string[] };
      const items = doc.getMap<Orb>("items");
      items.set("orb", { position: { x: 18, y: 24 }, labels: ["captured"] });
      const captured = captureYjs(doc);

      const callerBytes = captured.encode();
      callerBytes.fill(0);
      items.set("orb", { position: { x: 71, y: 83 }, labels: ["live"] });
      items.set("later", { position: { x: 99, y: 99 }, labels: ["new"] });

      const first = await captured.read((copy) => {
        const projectionItems = copy.getMap<Orb>("items");
        projectionItems.set("orb", { position: { x: 33, y: 44 }, labels: ["projector"] });
        return projectionItems.get("orb") as unknown as JsonValue;
      });
      expect(first).toEqual({ position: { x: 33, y: 44 }, labels: ["projector"] });
      expect(Object.isFrozen(first)).toBe(true);
      const firstOrb = first as { position: { x: number; y: number }; labels: string[] };
      expect(Object.isFrozen(firstOrb.position)).toBe(true);
      expect(Object.isFrozen(firstOrb.labels)).toBe(true);
      expect(items.get("orb")).toEqual({ position: { x: 71, y: 83 }, labels: ["live"] });

      expect(() => {
        firstOrb.position.x = 900;
      }).toThrow();
      const second = await captured.read((copy) =>
        copy.getMap<Orb>("items").get("orb") as unknown as JsonValue,
      );
      expect(second).toEqual({ position: { x: 18, y: 24 }, labels: ["captured"] });

      const validBytes = captured.encode();
      expect(validBytes.some((byte) => byte !== 0)).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  it("remains readable after the captured source document is destroyed", async () => {
    const doc = new Y.Doc();
    doc.getText("text").insert(0, "captured text");
    const captured = captureYjs(doc);
    doc.destroy();

    await expect(captured.read((copy) => copy.getText("text").toString()))
      .resolves.toBe("captured text");
  });

  it("keeps the materialized document alive for an asynchronous projector, then destroys it", async () => {
    const doc = new Y.Doc();
    try {
      doc.getMap<string>("items").set("value", "captured");
      const captured = captureYjs(doc);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let materialized: Y.Doc | undefined;
      let destroyed = false;

      const pending = captured.read(async (copy) => {
        materialized = copy;
        copy.on("destroy", () => { destroyed = true; });
        await gate;
        return copy.getMap<string>("items").get("value")!;
      });
      await Promise.resolve();
      expect(materialized).toBeInstanceOf(Y.Doc);
      expect(destroyed).toBe(false);

      doc.getMap<string>("items").set("value", "changed live");
      release();
      await expect(pending).resolves.toBe("captured");
      expect(destroyed).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  it("destroys the materialized document when projection or JSON normalization fails", async () => {
    const doc = new Y.Doc();
    try {
      doc.getMap<string>("items").set("value", "captured");
      const captured = captureYjs(doc);
      const projectionError = new Error("projection failed");
      let destroyedAfterThrow = false;
      await expect(captured.read((copy) => {
        copy.on("destroy", () => { destroyedAfterThrow = true; });
        throw projectionError;
      })).rejects.toBe(projectionError);
      expect(destroyedAfterThrow).toBe(true);

      let destroyedAfterInvalidJson = false;
      await expect(captured.read((copy) => {
        copy.on("destroy", () => { destroyedAfterInvalidJson = true; });
        return undefined as unknown as JsonValue;
      })).rejects.toThrow();
      expect(destroyedAfterInvalidJson).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  it("rejects subdocuments because the captured update contains references but not their contents", () => {
    const parent = new Y.Doc();
    const child = new Y.Doc();
    try {
      parent.getMap<Y.Doc>("subdocs").set("child", child);
      expect(parent.getSubdocs().size).toBeGreaterThan(0);
      expect(() => captureYjs(parent)).toThrow(/subdocuments/u);
    } finally {
      parent.destroy();
      child.destroy();
    }
  });
});
