import * as Y from "yjs";
import {
  normalizeJson,
  type JsonValue,
} from "@foxworth/boundary/program";

/** @experimental Boundary snapshot adapter; its API may change incompatibly. */
export interface YjsCapture {
  readonly engine: "yjs";
  /** Hex encoded Yjs Snapshot bytes, including the snapshot delete set. */
  readonly frontier: string;
  /** Return a fresh copy of the captured full-state update. */
  encode(): Uint8Array;
  /** Project JSON data from a newly materialized document for each read. */
  read<Result extends JsonValue>(
    project: (doc: Y.Doc) => Result | PromiseLike<Result>,
  ): Promise<Result>;
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

/**
 * Capture an immutable, process-local view of one Yjs document state.
 * Subdocuments are refused because a full-state update contains their
 * references, not the subdocuments' contents.
 * @experimental For evaluation; no production support commitment. The API may change incompatibly.
 */
export function captureYjs(doc: Y.Doc): YjsCapture {
  if (doc.getSubdocs().size > 0) {
    throw new TypeError("Yjs capture does not support subdocuments");
  }

  const snapshot = Y.encodeSnapshot(Y.snapshot(doc));
  const frontier = hex(snapshot);
  const ownedUpdate = Y.encodeStateAsUpdate(doc).slice();

  return Object.freeze({
    engine: "yjs" as const,
    frontier,
    encode: () => ownedUpdate.slice(),
    async read<Result extends JsonValue>(
      project: (materialized: Y.Doc) => Result | PromiseLike<Result>,
    ): Promise<Result> {
      const materialized = new Y.Doc();
      try {
        Y.applyUpdate(materialized, ownedUpdate.slice());
        return normalizeJson(await project(materialized)) as Result;
      } finally {
        materialized.destroy();
      }
    },
  });
}
