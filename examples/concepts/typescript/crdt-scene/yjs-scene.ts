import * as Y from "yjs";
import { captureYjs } from "@foxworth/boundary/yjs";
import { validateScene, type Scene } from "./contracts.ts";
import {
  createCaptureReadGate,
  runSceneHostProof,
  type CaptureReadGate,
  type SceneEngineDriver,
} from "./scene-host.ts";
import {
  startLocalReplicaRelay,
  type ReplicaRelay,
  type ReplicaRelayFactory,
} from "./transport.ts";

function readScene(doc: Y.Doc): Scene {
  const items = doc.getArray<Y.Map<unknown>>("scene.items").toArray().map((item) => ({
    id: item.get("id"),
    x: item.get("x"),
    y: item.get("y"),
    label: item.get("label"),
  }));
  return validateScene({ items });
}

function setItem(doc: Y.Doc, id: string, update: Readonly<Record<string, string | number>>): void {
  const item = doc.getArray<Y.Map<unknown>>("scene.items").toArray().find((entry) => entry.get("id") === id);
  if (!item) throw new Error(`Unknown scene item: ${id}`);
  doc.transact(() => {
    for (const [key, value] of Object.entries(update)) item.set(key, value);
  });
}

function deleteItem(doc: Y.Doc, id: string): void {
  const items = doc.getArray<Y.Map<unknown>>("scene.items");
  const index = items.toArray().findIndex((entry) => entry.get("id") === id);
  if (index < 0) throw new Error(`Unknown scene item: ${id}`);
  items.delete(index, 1);
}

function seed(doc: Y.Doc): void {
  const orb = new Y.Map<unknown>();
  orb.set("id", "orb");
  orb.set("x", 0);
  orb.set("y", 0);
  orb.set("label", "Orb");
  const spark = new Y.Map<unknown>();
  spark.set("id", "spark");
  spark.set("x", 4);
  spark.set("y", 4);
  spark.set("label", "Spark");
  doc.getArray<Y.Map<unknown>>("scene.items").insert(0, [orb, spark]);
}

async function createDriver(relayFactory: ReplicaRelayFactory): Promise<SceneEngineDriver> {
  const left = new Y.Doc();
  const right = new Y.Doc();
  let relay: ReplicaRelay | undefined;
  try {
    seed(left);
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    relay = await relayFactory((direction, update) => {
      Y.applyUpdate(direction === "left-to-right" ? right : left, update);
    });
    const activeRelay = relay;

    const leftBaseline = Y.encodeStateVector(left);
    const rightBaseline = Y.encodeStateVector(right);
    setItem(left, "orb", { x: 12 });
    setItem(right, "spark", { label: "Star" });
    await activeRelay.deliver("left-to-right", Y.encodeStateAsUpdate(left, rightBaseline));
    await activeRelay.deliver("right-to-left", Y.encodeStateAsUpdate(right, leftBaseline));
    const initialConcurrent = readScene(left);
    if (JSON.stringify(readScene(right)) !== JSON.stringify(initialConcurrent)) {
      throw new Error("Yjs replica updates did not converge");
    }

    let nextReadGate: CaptureReadGate | undefined;
    return {
      engine: "yjs",
      transport: activeRelay.evidence,
      initialConcurrent,
      capture() {
        const snapshot = captureYjs(left);
        const gate = nextReadGate;
        nextReadGate = undefined;
        return Object.freeze({
          engine: snapshot.engine,
          marker: snapshot.frontier,
          encode: () => snapshot.encode(),
          read: () => snapshot.read(async (doc) => {
            if (gate) {
              gate.begin();
              await gate.wait();
            }
            return readScene(doc);
          }),
        });
      },
      readLive: () => readScene(left),
      async move(id, x, y) {
        const peerState = Y.encodeStateVector(right);
        setItem(left, id, { x, y });
        await activeRelay.deliver("left-to-right", Y.encodeStateAsUpdate(left, peerState));
      },
      async delete(id) {
        deleteItem(left, id);
        await activeRelay.deliver("left-to-right", Y.encodeStateAsUpdate(left));
      },
      restore(bytes) {
        const restored = new Y.Doc();
        try {
          Y.applyUpdate(restored, bytes);
          return readScene(restored);
        } finally {
          restored.destroy();
        }
      },
      pauseNextCaptureRead() {
        if (nextReadGate) throw new Error("A Yjs capture read is already paused");
        nextReadGate = createCaptureReadGate();
        return nextReadGate;
      },
      async close() {
        try {
          await activeRelay.close();
        } finally {
          left.destroy();
          right.destroy();
        }
      },
    };
  } catch (error) {
    try {
      await relay?.close();
    } finally {
      left.destroy();
      right.destroy();
    }
    throw error;
  }
}

/** Run the shared acceptance journey using native Y.Doc updates and captures. */
export async function runYjsSceneProof(
  relayFactory: ReplicaRelayFactory = startLocalReplicaRelay,
) {
  const driver = await createDriver(relayFactory);
  return runSceneHostProof(driver);
}
