import * as Automerge from "@automerge/automerge";
import { captureAutomerge } from "@foxworth/boundary/automerge";
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

interface SceneItemState {
  id: string;
  x: number;
  y: number;
  label: string;
}

interface SceneState extends Record<string, unknown> {
  items: SceneItemState[];
}

function readScene(doc: Automerge.Doc<SceneState>): Scene {
  return validateScene({ items: doc.items.map((item) => ({ ...item })) });
}

function updateItem(
  doc: Automerge.Doc<SceneState>,
  id: string,
  update: Partial<SceneItemState>,
): Automerge.Doc<SceneState> {
  return Automerge.change(doc, (draft) => {
    const item = draft.items.find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown scene item: ${id}`);
    Object.assign(item, update);
  });
}

function deleteItem(doc: Automerge.Doc<SceneState>, id: string): Automerge.Doc<SceneState> {
  return Automerge.change(doc, (draft) => {
    const index = draft.items.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`Unknown scene item: ${id}`);
    draft.items.splice(index, 1);
  });
}

async function createDriver(relayFactory: ReplicaRelayFactory): Promise<SceneEngineDriver> {
  let left = Automerge.from<SceneState>({ items: [
    { id: "orb", x: 0, y: 0, label: "Orb" },
    { id: "spark", x: 4, y: 4, label: "Spark" },
  ] });
  let right = Automerge.clone(left);
  let leftSync = Automerge.initSyncState();
  let rightSync = Automerge.initSyncState();
  let relay: ReplicaRelay | undefined;

  try {
    relay = await relayFactory((direction, update) => {
      if (direction === "left-to-right") {
        [right, rightSync] = Automerge.receiveSyncMessage(right, rightSync, update);
      } else {
        [left, leftSync] = Automerge.receiveSyncMessage(left, leftSync, update);
      }
    });
    const activeRelay = relay;

    const synchronize = async () => {
      for (let turn = 0; turn < 20; turn++) {
        let sent = false;
        const [nextLeftSync, leftMessage] = Automerge.generateSyncMessage(left, leftSync);
        leftSync = nextLeftSync;
        if (leftMessage) {
          sent = true;
          await activeRelay.deliver("left-to-right", leftMessage);
        }
        const [nextRightSync, rightMessage] = Automerge.generateSyncMessage(right, rightSync);
        rightSync = nextRightSync;
        if (rightMessage) {
          sent = true;
          await activeRelay.deliver("right-to-left", rightMessage);
        }
        if (!sent) return;
      }
      throw new Error("Automerge replicas did not settle within bounded Sync exchange");
    };

    left = updateItem(left, "orb", { x: 12 });
    right = updateItem(right, "spark", { label: "Star" });
    await synchronize();
    const initialConcurrent = readScene(left);
    if (JSON.stringify(readScene(right)) !== JSON.stringify(initialConcurrent)) {
      throw new Error("Automerge Sync replicas did not converge");
    }

    let nextReadGate: CaptureReadGate | undefined;
    return {
      engine: "automerge",
      transport: activeRelay.evidence,
      initialConcurrent,
      capture() {
        const snapshot = captureAutomerge(left);
        const gate = nextReadGate;
        nextReadGate = undefined;
        return Object.freeze({
          engine: snapshot.engine,
          marker: Object.freeze([...snapshot.heads]),
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
        left = updateItem(left, id, { x, y });
        await synchronize();
      },
      async delete(id) {
        left = deleteItem(left, id);
        await synchronize();
      },
      restore(bytes) {
        const restored = Automerge.load<SceneState>(bytes);
        try {
          return readScene(restored);
        } finally {
          Automerge.free(restored);
        }
      },
      pauseNextCaptureRead() {
        if (nextReadGate) throw new Error("An Automerge capture read is already paused");
        nextReadGate = createCaptureReadGate();
        return nextReadGate;
      },
      async close() {
        try {
          await activeRelay.close();
        } finally {
          Automerge.free(left);
          Automerge.free(right);
        }
      },
    };
  } catch (error) {
    try {
      await relay?.close();
    } finally {
      Automerge.free(left);
      Automerge.free(right);
    }
    throw error;
  }
}

/** Run the shared acceptance journey using native Automerge changes and Sync messages. */
export async function runAutomergeSceneProof(
  relayFactory: ReplicaRelayFactory = startLocalReplicaRelay,
) {
  const driver = await createDriver(relayFactory);
  return runSceneHostProof(driver);
}
