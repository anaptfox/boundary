import { z } from "zod";

export type SceneActor = Readonly<{
  id: string;
  role: "editor" | "reviewer";
}>;

export const sceneActors = Object.freeze({
  editor: Object.freeze({ id: "editor-local", role: "editor" } as const),
  reviewer: Object.freeze({ id: "reviewer-local", role: "reviewer" } as const),
  denied: Object.freeze({ id: "reader-local", role: "reviewer" } as const),
});

export const SceneItemSchema = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
  label: z.string(),
});

export const SceneSchema = z.strictObject({
  items: z.array(SceneItemSchema),
});

export const MoveInputSchema = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
});

export const CandidateRefSchema = z.strictObject({ candidateId: z.string().min(1) });

export const AcceptedSchema = z.strictObject({
  candidateId: z.string().min(1),
  resourceId: z.string().min(1),
  generation: z.string().min(1),
  engine: z.enum(["yjs", "automerge"]),
  acceptanceVersion: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const StaleCandidateSchema = z.strictObject({
  candidateId: z.string().min(1),
});

export type SceneItem = z.infer<typeof SceneItemSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type CandidateRef = Readonly<z.infer<typeof CandidateRefSchema>>;
export type AcceptedRecord = Readonly<z.infer<typeof AcceptedSchema>>;

export const sceneResource = "scene:demo:one";
export const sceneGeneration = "generation:one";

export function validateScene(value: unknown): Scene {
  const scene = SceneSchema.parse(value);
  const seen = new Set<string>();
  for (const item of scene.items) {
    if (seen.has(item.id)) throw new Error("scene item IDs must be unique");
    seen.add(item.id);
  }
  return Object.freeze({
    items: Object.freeze(scene.items.map((item) => Object.freeze({ ...item }))),
  }) as unknown as Scene;
}

export function sceneJson(scene: Scene): string {
  return JSON.stringify(scene);
}

export function renderScene(scene: Scene): string {
  const escapeAttribute = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
  const items = scene.items.map((item) =>
    `<circle data-id="${escapeAttribute(item.id)}" data-label="${escapeAttribute(item.label)}" cx="${item.x}" cy="${item.y}" r="5"/>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${items}</svg>`;
}
