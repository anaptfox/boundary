import * as Automerge from "@automerge/automerge";
import { normalizeJson, type JsonValue } from "@foxworth/boundary/program";

/** @experimental Boundary snapshot adapter; its API may change incompatibly. */
export interface AutomergeCapture<T> {
  readonly engine: "automerge";
  readonly heads: readonly string[];
  encode(): Uint8Array;
  read<Result extends JsonValue>(
    project: (doc: Automerge.Doc<T>) => Result | PromiseLike<Result>,
  ): Promise<Result>;
}

/**
 * Capture one Automerge version for isolated projections that return portable JSON.
 * @experimental For evaluation; no production support commitment. The API may change incompatibly.
 */
export function captureAutomerge<T>(doc: Automerge.Doc<T>): AutomergeCapture<T> {
  // `save` serializes the backing handle's latest state, which may be newer
  // than a view's advertised heads. Clone first so the captured bytes and
  // heads both describe the exact version supplied by the caller.
  const snapshot = Automerge.clone(doc);
  let snapshotBytes: Uint8Array;
  let heads: readonly string[];
  try {
    snapshotBytes = new Uint8Array(Automerge.save(snapshot));
    heads = Object.freeze([...Automerge.getHeads(snapshot)]);
  } finally {
    Automerge.free(snapshot);
  }

  return Object.freeze({
    engine: "automerge" as const,
    heads,
    encode() {
      return new Uint8Array(snapshotBytes);
    },
    async read<Result extends JsonValue>(
      project: (source: Automerge.Doc<T>) => Result | PromiseLike<Result>,
    ): Promise<Result> {
      const source = Automerge.load<T>(new Uint8Array(snapshotBytes));
      try {
        return normalizeJson(await project(source)) as Result;
      } finally {
        Automerge.free(source);
      }
    },
  });
}
