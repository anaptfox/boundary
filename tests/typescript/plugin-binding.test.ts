import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { portableSchema } from "@foxworth/boundary/program";
import { bindSurface, compileInteractions, installInteractions, projectInteractions } from "../../packages/core/host/pipeline";
import { defineInteraction } from "../../packages/core/host/index";
import {
  HostImports,
  createPluginExecutor,
  loadPlugin,
} from "../../packages/guests/plugin/index";

let executor: ReturnType<typeof createPluginExecutor> | undefined;
let loadedInstance: { close(): Promise<void> } | undefined;

afterEach(async () => {
  await loadedInstance?.close();
  await executor?.close();
  loadedInstance = undefined;
  executor = undefined;
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginPath = resolve(
  root,
  "examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm",
);
const interfaceName = "boundary:guest/footprints@1.0.0";
const witDigest = `sha256:${createHash("sha256")
  .update(readFileSync(resolve(root, "examples/guests/thumbnail/zig/wit/guest.wit")))
  .digest("hex")}`;

const input = portableSchema<{ readonly imageId: string; readonly maxWidth: number }>({
  type: "object",
  properties: {
    imageId: { type: "string" },
    maxWidth: { type: "integer", minimum: 1 },
  },
  required: ["imageId", "maxWidth"],
  additionalProperties: false,
});
const output = portableSchema<{ readonly imageId: string; readonly width: number; readonly height: number }>({
  type: "object",
  properties: {
    imageId: { type: "string" },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
  required: ["imageId", "width", "height"],
  additionalProperties: false,
});

const definitions = {
  makeThumbnail: defineInteraction({
    id: "images.makeThumbnail",
    input,
    output,
    reads: ["images"],
    changes: ["images"],
  }),
} as const;

describe("plugin Binding", () => {
  it.skipIf(!existsSync(pluginPath))("binds an admitted thumbnail plugin and keeps an uncertain host effect uncertain", async () => {
    executor = createPluginExecutor();
    let uncertain = false;
    let importCalls = 0;
    const loaded = await loadPlugin({
      bytes: new Uint8Array(readFileSync(pluginPath)),
      imports: new HostImports(interfaceName).provide("images"),
      witDigest,
      executor,
      host: {
        async images(request, { signal }) {
          if (signal.aborted) return { tag: "unknown", val: "aborted" };
          importCalls += 1;
          if (uncertain) return { tag: "unknown", val: "write acknowledgement lost" };
          JSON.parse(request) as { imageId: string };
          return JSON.stringify({
            width: 800,
            height: 600,
          });
        },
      },
    });
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") return;
    loadedInstance = loaded.instance;
    expect(loaded.inspection.check).toEqual({ status: "satisfied", used: ["images"] });
    const direct = await loaded.instance.call(
      "images-make-thumbnail",
      JSON.stringify({ imageId: "original", maxWidth: 200 }),
    );
    expect(direct).toMatchObject({ status: "returned" });

    const compiled = await compileInteractions(definitions);
    const { installation } = await installInteractions(compiled, {
      installationId: "images:plugin:thumbnail:1",
      realizationIds: {
        makeThumbnail: { direct: loaded.inspection.realizationId },
      },
      bindings: [{
        interaction: compiled.handles.makeThumbnail,
        target: loaded.instance,
        async dispatch({ input: interactionInput, outcomes }) {
          const result = await loaded.instance.call(
            "images-make-thumbnail",
            JSON.stringify(interactionInput),
          );
          if (result.status === "returned") {
            return outcomes.returned(JSON.parse(result.payload));
          }
          if (result.status === "declared-error") {
            // The sample interaction declares no domain errors; a plugin that
            // returns one cannot turn it into a successful thumbnail.
            return outcomes.unknown();
          }
          return result.certainty === "not-started"
            ? outcomes.notStarted()
            : result.certainty === "not-completed"
              ? outcomes.notCompleted()
            : outcomes.unknown();
        },
      }],
    });
    const projection = await projectInteractions(compiled, {
      makeThumbnail: { interaction: compiled.handles.makeThumbnail, modes: ["direct"] },
    });
    const binding = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    expect(binding.status).toBe("bound");
    if (binding.status !== "bound") return;

    const interaction = binding.binding.resolve("images.makeThumbnail")!;
    await expect(
      binding.binding.connect().callRaw(interaction, { imageId: "original", maxWidth: 200 }),
    ).resolves.toMatchObject({
      certainty: "completed",
      result: { kind: "returned", value: { imageId: "original", width: 200, height: 150 } },
    });

    uncertain = true;
    const beforeUncertain = importCalls;
    await expect(
      binding.binding.connect().callRaw(interaction, { imageId: "original", maxWidth: 200 }),
    ).resolves.toMatchObject({
      certainty: "unknown",
      result: { kind: "fault", cause: "realization-failed" },
    });
    expect(importCalls).toBe(beforeUncertain + 1);
  });
});
