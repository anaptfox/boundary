import { describe, expect, it } from "vitest";
import { runAutomergeSceneProof } from "../../examples/concepts/typescript/crdt-scene/automerge-scene";
import { renderScene, validateScene } from "../../examples/concepts/typescript/crdt-scene/contracts";
import { startInProcessReplicaRelay } from "../../examples/concepts/typescript/crdt-scene/transport";
import { runYjsSceneProof } from "../../examples/concepts/typescript/crdt-scene/yjs-scene";

describe("native CRDT scene examples", () => {
  it.each([
    ["Yjs", runYjsSceneProof],
    ["Automerge", runAutomergeSceneProof],
  ] as const)("runs the %s native scene acceptance journey", async (_name, runProof) => {
    const proof = await runProof(startInProcessReplicaRelay);
    expect(proof.transport).toBe("in-process native replica exchange");
    expect(proof.concurrent.items).toEqual([
      { id: "orb", x: 12, y: 0, label: "Orb" },
      { id: "spark", x: 4, y: 4, label: "Star" },
    ]);
    expect(proof.capturedBeforeLaterEdit.items.map((item) => item.id)).toEqual(["orb", "spark"]);
    expect(proof.capturedBeforeLaterEdit.items[0]).toMatchObject({ x: 18, y: 24 });
    expect(proof.liveAfterLaterDeletion.items.map((item) => item.id)).toEqual(["orb"]);
    expect(proof.restored.items.map((item) => item.id)).toEqual(["orb", "spark"]);
    expect(proof.restored.items[0]).toMatchObject({ x: 18, y: 24 });
    expect(proof.accepted.acceptanceVersion).toBe(1);
    expect(proof.delayedCaptureRejected).toBe(true);
    expect(proof.concurrentAccepts.sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("validates scene identity and bounds before safely rendering attributes", () => {
    expect(() => validateScene({ items: [
      { id: "same", x: 0, y: 0, label: "one" },
      { id: "same", x: 1, y: 1, label: "two" },
    ] })).toThrow();
    expect(() => validateScene({ items: [{ id: "orb", x: 101, y: 0, label: "Orb" }] })).toThrow();

    const rendered = renderScene(validateScene({
      items: [{ id: `orb" onload="bad`, x: 3, y: 4, label: `<script>&"'` }],
    }));
    expect(rendered).toContain('data-id="orb&quot; onload=&quot;bad"');
    expect(rendered).toContain('data-label="&lt;script&gt;&amp;&quot;&#39;"');
    expect(rendered).not.toContain("<script>");
  });
});
