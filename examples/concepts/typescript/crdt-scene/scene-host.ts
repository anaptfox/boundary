import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitWhen,
  declaredInteractionError,
  defineInteraction,
  install,
  surface,
} from "@foxworth/boundary";
import {
  AcceptedSchema,
  CandidateRefSchema,
  MoveInputSchema,
  SceneSchema,
  StaleCandidateSchema,
  sceneActors,
  sceneGeneration,
  sceneResource,
  renderScene,
  validateScene,
  type AcceptedRecord,
  type CandidateRef,
  type Scene,
  type SceneActor,
} from "./contracts.ts";

export interface FrozenSceneCapture {
  readonly engine: "yjs" | "automerge";
  readonly marker: string | readonly string[];
  encode(): Uint8Array;
  read(): Promise<Scene>;
}

export interface CaptureReadBarrier {
  readonly started: Promise<void>;
  release(): void;
}

export interface CaptureReadGate extends CaptureReadBarrier {
  begin(): void;
  wait(): Promise<void>;
}

export function createCaptureReadGate(): CaptureReadGate {
  let start!: () => void;
  let release!: () => void;
  let started = false;
  let released = false;
  const startedPromise = new Promise<void>((resolve) => { start = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  return Object.freeze({
    started: startedPromise,
    begin() {
      if (!started) {
        started = true;
        start();
      }
    },
    wait() {
      return released ? Promise.resolve() : releasePromise;
    },
    release() {
      if (!released) {
        released = true;
        release();
      }
    },
  });
}

export interface SceneEngineDriver {
  readonly engine: "yjs" | "automerge";
  readonly transport: string;
  readonly initialConcurrent: Scene;
  capture(): FrozenSceneCapture;
  readLive(): Scene;
  move(id: string, x: number, y: number): Promise<void>;
  delete(id: string): Promise<void>;
  restore(bytes: Uint8Array): Scene;
  pauseNextCaptureRead(): CaptureReadBarrier;
  close(): Promise<void>;
}

const interactions = {
  move: defineInteraction({
    id: "example.crdt-scene.move",
    input: MoveInputSchema,
    output: SceneSchema,
    reads: ["scene.working"],
    changes: ["scene.working"],
  }),
  capture: defineInteraction({
    id: "example.crdt-scene.capture",
    output: CandidateRefSchema,
    reads: ["scene.working", "scene.accepted"],
    changes: ["scene.candidates"],
  }),
  render: defineInteraction({
    id: "example.crdt-scene.render",
    input: CandidateRefSchema,
    output: SceneSchema,
    reads: ["scene.candidates"],
    changes: [],
  }),
  accept: defineInteraction({
    id: "example.crdt-scene.accept",
    input: CandidateRefSchema,
    output: AcceptedSchema,
    errors: {
      staleCandidate: StaleCandidateSchema,
      missingCandidate: CandidateRefSchema,
    },
    reads: ["scene.candidates", "scene.accepted"],
    changes: ["scene.accepted"],
  }),
} as const;

type Candidate = Readonly<{
  reference: CandidateRef;
  capture: FrozenSceneCapture;
  content: Scene;
  contentDigest: string;
  resourceId: string;
  generation: string;
  baseAcceptanceVersion: number;
}>;

function digestScene(scene: Scene): string {
  const canonicalItems = scene.items.map(({ id, x, y, label }) => [id, x, y, label]);
  return createHash("sha256").update(JSON.stringify(canonicalItems)).digest("hex");
}

function isStale(candidate: Candidate, acceptanceVersion: number): boolean {
  return candidate.resourceId !== sceneResource ||
    candidate.generation !== sceneGeneration ||
    candidate.baseAcceptanceVersion !== acceptanceVersion;
}

/**
 * Shared host-owned scene interactions and acceptance journey for the two
 * engine-native examples. This helper is example-local, not an SDK API.
 */
export async function runSceneHostProof(engine: SceneEngineDriver) {
  let acceptanceVersion = 0;
  let candidateNumber = 0;
  let accepted: AcceptedRecord | undefined;
  let acceptedCandidate: Candidate | undefined;
  const candidates = new Map<string, Candidate>();
  let storage: string | undefined;

  try {
    storage = await mkdtemp(join(tmpdir(), `boundary-${engine.engine}-scene-`));
    const app = await install(interactions, {
      id: `example:crdt:${engine.engine}:one`,
      version: `${engine.engine}-scene:v1`,
      handlers: {
        async move(input, _actor: SceneActor) {
          await engine.move(input.id, input.x, input.y);
          return engine.readLive();
        },
        async capture(_actor: SceneActor) {
          // Pin before the first await: a concurrent successful accept must make
          // this candidate stale even while its immutable projection is pending.
          const baseAcceptanceVersion = acceptanceVersion;
          const capture = engine.capture();
          const content = validateScene(await capture.read());
          const candidateId = `${engine.engine}-candidate-${++candidateNumber}`;
          const candidate = Object.freeze({
            reference: Object.freeze({ candidateId }),
            capture,
            content,
            contentDigest: digestScene(content),
            resourceId: sceneResource,
            generation: sceneGeneration,
            baseAcceptanceVersion,
          });
          candidates.set(candidateId, candidate);
          return candidate.reference;
        },
        async render(reference, _actor: SceneActor) {
          const candidate = candidates.get(reference.candidateId);
          if (!candidate) throw new Error("Unknown scene candidate");
          const content = validateScene(await candidate.capture.read());
          if (digestScene(content) !== candidate.contentDigest) {
            throw new Error("Captured scene content changed after materialization");
          }
          return content;
        },
        accept(reference, _actor: SceneActor) {
          const candidate = candidates.get(reference.candidateId);
          if (!candidate) {
            throw declaredInteractionError(interactions.accept, "missingCandidate", reference);
          }
          // There is no await between this baseline check and commit. Concurrent
          // callers therefore serialize on the host-owned acceptance version.
          if (isStale(candidate, acceptanceVersion)) {
            throw declaredInteractionError(interactions.accept, "staleCandidate", reference);
          }
          validateScene(candidate.content);
          if (digestScene(candidate.content) !== candidate.contentDigest) {
            throw declaredInteractionError(interactions.accept, "staleCandidate", reference);
          }
          const nextVersion = acceptanceVersion + 1;
          const record = Object.freeze({
            candidateId: candidate.reference.candidateId,
            resourceId: candidate.resourceId,
            generation: candidate.generation,
            engine: candidate.capture.engine,
            acceptanceVersion: nextVersion,
            contentDigest: candidate.contentDigest,
          });
          accepted = record;
          acceptedCandidate = candidate;
          acceptanceVersion = nextVersion;
          return record;
        },
      },
    });
    const editor = await app.connect(surface.all(interactions), {
      admit: admitWhen((actor: SceneActor) => actor.role === "editor", "Editor required"),
    });
    const reviewer = await app.connect(surface(interactions, { call: ["capture", "render"] }), {
      admit: admitWhen((actor: SceneActor) => actor.role === "reviewer", "Reviewer required"),
    });
    const boundary = { callers: { editor, reviewer } };

    assert.deepEqual(Object.keys(boundary.callers.reviewer), ["capture", "render"]);
    assert.equal("move" in boundary.callers.reviewer, false);
    const beforeDenied = engine.readLive();
    await assert.rejects(
      boundary.callers.editor.move({ id: "orb", x: 13, y: 1 }, sceneActors.denied),
    );
    assert.deepEqual(engine.readLive(), beforeDenied, "denied actors cannot dispatch a native edit");

    await boundary.callers.editor.move({ id: "orb", x: 18, y: 24 }, sceneActors.editor);
    const candidateA = await boundary.callers.reviewer.capture(sceneActors.reviewer);
    const renderedA = await boundary.callers.reviewer.render(candidateA, sceneActors.reviewer);
    const svgA = renderScene(renderedA);
    await boundary.callers.editor.move({ id: "orb", x: 71, y: 83 }, sceneActors.editor);
    await engine.delete("spark");
    const liveAfterEdit = engine.readLive();
    assert.deepEqual(liveAfterEdit.items.map((item) => item.id), ["orb"]);
    const stillA = await boundary.callers.reviewer.render(candidateA, sceneActors.reviewer);
    assert.deepEqual(stillA, renderedA, "later edits and deletion leave the capture immutable");
    assert.match(svgA, /cx="18" cy="24"/);
    assert.match(svgA, /data-id="spark"/);
    assert.doesNotMatch(renderScene(liveAfterEdit), /data-id="spark"/);

    const acceptedA = await boundary.callers.editor.accept(candidateA, sceneActors.editor);
    assert.equal(acceptedA.acceptanceVersion, 1, "live changes do not invalidate a frozen candidate");
    assert.equal(acceptedA.contentDigest, digestScene(renderedA));
    assert.deepEqual(acceptedCandidate?.content, renderedA);

    const candidateB = await boundary.callers.editor.capture(sceneActors.editor);
    const candidateC = await boundary.callers.editor.capture(sceneActors.editor);
    const race = await Promise.allSettled([
      boundary.callers.editor.accept(candidateB, sceneActors.editor),
      boundary.callers.editor.accept(candidateC, sceneActors.editor),
    ]);
    const raceSuccesses = race.filter((result) => result.status === "fulfilled");
    const raceFailures = race.filter((result) => result.status === "rejected");
    assert.equal(raceSuccesses.length, 1);
    assert.equal(raceFailures.length, 1);
    assert.equal((raceFailures[0] as PromiseRejectedResult).reason.code, "staleCandidate");
    assert.equal(acceptanceVersion, 2);

    const candidateE = await boundary.callers.editor.capture(sceneActors.editor);
    const barrier = engine.pauseNextCaptureRead();
    const delayedCapture = boundary.callers.editor.capture(sceneActors.editor);
    await barrier.started;
    await boundary.callers.editor.accept(candidateE, sceneActors.editor);
    barrier.release();
    const candidateD = await delayedCapture;
    await assert.rejects(
      boundary.callers.editor.accept(candidateD, sceneActors.editor),
      (error: unknown) => (error as { code?: string }).code === "staleCandidate",
    );
    assert.equal(accepted?.candidateId, candidateE.candidateId);
    assert.equal(acceptanceVersion, 3);
    assert.equal(acceptedCandidate?.contentDigest, digestScene(engine.readLive()));

    // Persist the earlier accepted A candidate after the live scene has moved,
    // lost spark, and other candidates have since been accepted.
    const persisted = candidates.get(candidateA.candidateId);
    assert.ok(persisted);
    const bytesPath = join(storage, `candidate.${engine.engine}.bytes`);
    const metadataPath = join(storage, "candidate.json");
    const metadata = {
      ...acceptedA,
      captureMarker: persisted.capture.marker,
      content: persisted.content,
    };
    await writeFile(bytesPath, persisted.capture.encode());
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restoredContent = engine.restore(new Uint8Array(await readFile(bytesPath)));
    const restoredMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      candidateId: string;
      content: Scene;
      contentDigest: string;
    };
    assert.deepEqual(restoredContent, restoredMetadata.content);
    assert.equal(restoredMetadata.candidateId, acceptedA.candidateId);
    assert.equal(digestScene(restoredContent), restoredMetadata.contentDigest);

    const beforeRevocation = engine.readLive();
    app.revoke(editor);
    await assert.rejects(
      boundary.callers.editor.move({ id: "orb", x: 90, y: 90 }, sceneActors.editor),
    );
    assert.deepEqual(engine.readLive(), beforeRevocation, "binding revocation prevents later edits");
    app.revoke();
    await assert.rejects(boundary.callers.reviewer.render(candidateA, sceneActors.reviewer));

    return Object.freeze({
      engine: engine.engine,
      transport: engine.transport,
      concurrent: engine.initialConcurrent,
      capturedBeforeLaterEdit: renderedA,
      liveAfterLaterDeletion: liveAfterEdit,
      accepted: acceptedA,
      finalAccepted: accepted,
      restored: restoredContent,
      concurrentAccepts: race.map((result) => result.status),
      delayedCaptureRejected: true,
    });
  } finally {
    try {
      await engine.close();
    } finally {
      if (storage) await rm(storage, { recursive: true, force: true });
    }
  }
}
