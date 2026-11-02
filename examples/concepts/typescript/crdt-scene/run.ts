import { runAutomergeSceneProof } from "./automerge-scene.ts";
import { runYjsSceneProof } from "./yjs-scene.ts";

const reports = [await runYjsSceneProof(), await runAutomergeSceneProof()];
for (const report of reports) {
  console.log(`${report.engine}: ${report.transport}, concurrent replicas converged, accepted snapshot survived later live edits, stale and racing accepts checked, retained capture reloaded`);
}
