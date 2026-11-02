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

  it("shares rendering between callers and connects a replacement explicitly", async () => {
    const example = await createThumbnailExample();
    const screen = await example.fromScreen();
    expect(screen).toEqual({ imageId: "original:w200", width: 200, height: 150 });
    expect(await example.fromScript()).toEqual(screen);
    expect(example.images.get(screen.imageId)?.svg).toContain('width="200" height="150"');
    expect(example.images.get(screen.imageId)?.svg).toContain('viewBox="0 0 800 600"');
    expect(await example.replacementCaller.makeThumbnail(
      { imageId: "original", maxWidth: 400 },
      { kind: "script" },
    )).toEqual({ imageId: "original:w400", width: 400, height: 300 });
    expect(example.dispatches).toEqual(["makeThumbnail", "makeThumbnail", "makeThumbnail"]);
    expect(example.replacementCaller.manifest.installationId).toBe("images:local:release-2");
    expect(example.thumbnails.manifest.installationId).toBe("images:local:release-1");
  });

  it("refuses a job-returning installation before dispatch", async () => {
    const example = await createThumbnailExample();
    expect(example.mismatch.status).toBe("unrealized");
    if (example.mismatch.status !== "unrealized") throw new Error("expected a refusal");
    expect(example.mismatch.report.issues.map((issue) => issue.reason)).toEqual(["incompatible-contract"]);
    expect(example.queuedDispatches).toEqual([]);
    expect(example.dispatches).toEqual([]);
  });

  it("narrows the agent surface and checks admission independently", async () => {
    const example = await createThumbnailExample();
    expect(Object.keys(example.agent)).toEqual(["makeThumbnail", "inspectImage"]);
    expect(example.app.binding(example.agent).resolve("images.delete")).toBeUndefined();
    expect(await example.agent.inspectImage({ imageId: "original" }, { kind: "agent" }))
      .toEqual({ imageId: "original", width: 800, height: 600 });
    const before = example.dispatches.length;
    await expect(example.agent.makeThumbnail(
      { imageId: "original", maxWidth: 100 },
      { kind: "screen" },
    )).rejects.toThrow();
    expect(example.dispatches).toHaveLength(before);
    expect(example.images.has("original:w100")).toBe(false);
  });
});
