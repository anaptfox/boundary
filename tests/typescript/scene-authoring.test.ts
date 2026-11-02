import { describe, expect, it } from "vitest";
import {
  createSceneAuthoringExample,
  sceneActors,
} from "../../examples/snippets/typescript/scene-authoring";

describe("scene authoring on the short path", () => {
  it("keeps host handlers behind narrow, admitted, revocable callers", async () => {
    const scene = await createSceneAuthoringExample();
    const { editor, assistant } = scene.callers;

    expect(Object.keys(editor)).toEqual(["move", "capture", "render"]);
    expect(Object.keys(assistant)).toEqual(["capture", "render"]);
    expect("move" in assistant).toBe(false);

    await editor.move({ id: "orb", x: 18, y: 24 }, sceneActors.editor);
    const captured = await assistant.capture(sceneActors.assistant);
    await editor.move({ id: "orb", x: 71, y: 83 }, sceneActors.editor);
    const svg = await assistant.render(captured, sceneActors.assistant);

    expect(svg).toContain('cx="18" cy="24"');
    expect(svg).toContain('data-revision="1"');
    expect(svg).not.toContain('cx="71" cy="83"');

    await expect(assistant.capture(sceneActors.editor)).rejects.toThrow();

    expect(scene.app.revoke(assistant)).toBe(true);
    await expect(assistant.render(captured, sceneActors.assistant)).rejects.toThrow();
  });
});
