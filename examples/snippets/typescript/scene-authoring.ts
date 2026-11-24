import { z } from "zod";
import {
  bindInteractions,
  defineInteraction,
  declaredInteractionError,
} from "@foxworth/boundary";

export type SceneActor = Readonly<{
  id: string;
  role: "editor" | "assistant";
}>;

export const sceneActors = {
  editor: { id: "editor-1", role: "editor" },
  assistant: { id: "assistant-1", role: "assistant" },
} as const satisfies Readonly<Record<string, SceneActor>>;

const Position = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
  revision: z.number().int().nonnegative(),
});

const MoveInput = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
});
const CandidateRef = z.strictObject({ candidateId: z.string().min(1) });
const MissingCandidate = z.strictObject({ candidateId: z.string().min(1) });

const sceneInteractions = {
  move: defineInteraction({
    id: "scene.move",
    input: MoveInput,
    output: Position,
    reads: ["scene.working"],
    changes: ["scene.working"],
  }),
  capture: defineInteraction({
    id: "scene.capture",
    output: CandidateRef,
    reads: ["scene.working"],
    changes: ["scene.candidates"],
  }),
  render: defineInteraction({
    id: "scene.render",
    input: CandidateRef,
    output: z.string(),
    errors: { missingCandidate: MissingCandidate },
    reads: ["scene.candidates"],
    changes: [],
  }),
} as const;

/** A small host-owned scene used by the executable authoring example. */
export async function createSceneAuthoringExample() {
  const positions = new Map<string, Readonly<{ x: number; y: number; revision: number }>>([
    ["orb", { x: 8, y: 12, revision: 0 }],
  ]);
  const candidates = new Map<string, Readonly<z.infer<typeof Position>>>();
  let nextCandidateId = 1;

  // #region binding-call
  const boundary = bindInteractions(sceneInteractions, {
    installationId: "scene:local:v1",
    realizationVersion: "scene-handlers:v1",
    handlers: {
      move(input, _actor: SceneActor) {
        const previous = positions.get(input.id);
        if (!previous) throw new Error(`Unknown scene item: ${input.id}`);
        const next = Object.freeze({
          x: input.x,
          y: input.y,
          revision: previous.revision + 1,
        });
        positions.set(input.id, next);
        return Object.freeze({ id: input.id, ...next });
      },
      capture(_actor: SceneActor) {
        const current = positions.get("orb");
        if (!current) throw new Error("The scene item is unavailable");
        const candidateId = `scene-candidate-${nextCandidateId++}`;
        candidates.set(candidateId, Object.freeze({ id: "orb", ...current }));
        return { candidateId };
      },
      render(reference, _actor: SceneActor) {
        const candidate = candidates.get(reference.candidateId);
        if (!candidate) {
          throw declaredInteractionError(
            sceneInteractions.render,
            "missingCandidate",
            { candidateId: reference.candidateId },
          );
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle data-revision="${candidate.revision}" cx="${candidate.x}" cy="${candidate.y}" r="5"/></svg>`;
      },
    },
    callers: {
      editor: {
        direct: ["move", "capture", "render"],
        admit: (actor) => actor.role === "editor",
      },
      assistant: {
        direct: ["capture", "render"],
        admit: (actor) => actor.role === "assistant",
      },
    },
  });
  // #endregion binding-call

  return Object.freeze({ ...boundary, actors: sceneActors });
}

// #region call-sequence
export async function runSceneAuthoringSequence() {
  const scene = await createSceneAuthoringExample();
  await scene.callers.editor.move({ id: "orb", x: 18, y: 24 }, scene.actors.editor);
  const captured = await scene.callers.assistant.capture(scene.actors.assistant);
  await scene.callers.editor.move({ id: "orb", x: 71, y: 83 }, scene.actors.editor);
  return scene.callers.assistant.render(captured, scene.actors.assistant);
}
// #endregion call-sequence
