import { describe, expect, it } from "vitest";
import { createThumbnailExample, runThumbnailExample } from "../../examples/snippets/typescript/thumbnail";

describe("thumbnail documentation example", () => {
  it("runs the teaching example from both callers", async () => {
    expect(await runThumbnailExample()).toEqual({
      screen: { imageId: "original:w200", width: 200, height: 150 },
      script: { imageId: "original:w200", width: 200, height: 150 },
      mismatch: "unrealized",
    });
  });

  it("shares rendering between callers and binds a replacement explicitly", async () => {
    const example = createThumbnailExample();
    const screen = await example.fromScreen();
    expect(screen).toEqual({ imageId: "original:w200", width: 200, height: 150 });
    expect(await example.fromScript()).toEqual(screen);
    expect(example.images.get(screen.imageId)?.svg).toContain('width="200" height="150"');
    expect(example.images.get(screen.imageId)?.svg).toContain('viewBox="0 0 800 600"');
    expect(await example.replacementCaller.call(
      example.thumbnailSurface.handles.makeThumbnail,
      { imageId: "original", maxWidth: 400 },
      { kind: "script" },
    )).toEqual({ imageId: "original:w400", width: 400, height: 300 });
    expect(example.dispatches).toEqual(["makeThumbnail", "makeThumbnail", "makeThumbnail"]);
  });

  it("refuses a job-returning installation before dispatch", () => {
    const example = createThumbnailExample();
    expect(example.mismatch.status).toBe("unrealized");
    expect(example.queuedDispatches).toEqual([]);
    expect(example.dispatches).toEqual([]);
  });

  it("narrows the agent surface and checks admission independently", async () => {
    const example = createThumbnailExample();
    expect(Object.keys(example.agentSurface.handles).sort()).toEqual(["inspectImage", "makeThumbnail"]);
    expect(example.agentBinding.resolve("images.delete")).toBeUndefined();
    expect(await example.agent.call(
      example.agentSurface.handles.inspectImage,
      { imageId: "original" },
      { kind: "agent" },
    )).toEqual({ imageId: "original", width: 800, height: 600 });
    const before = example.dispatches.length;
    await expect(example.agent.call(
      example.agentSurface.handles.makeThumbnail,
      { imageId: "original", maxWidth: 100 },
      { kind: "screen" },
    )).rejects.toThrow();
    expect(example.dispatches).toHaveLength(before);
    expect(example.images.has("original:w100")).toBe(false);
  });
});
