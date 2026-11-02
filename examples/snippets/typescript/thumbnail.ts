/**
 * A local executable teaching fixture. It resizes a trusted, generated SVG,
 * not an uploaded photograph. The replacement installation is in this process;
 * moving execution to a worker additionally needs a host-chosen transport.
 */
// #region imports
import {
  admitWhen,
  bindProjection,
  compileInteractions,
  direct,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
// #endregion imports

// #region thumbnail-contract
import { z } from "zod";
import { defineInteraction } from "@foxworth/boundary";

const ThumbnailInput = z.strictObject({
  imageId: z.string(),
  maxWidth: z.number().int().positive(),
});
const ImageInfo = z.strictObject({
  imageId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const makeThumbnailInteraction = defineInteraction({
  id: "images.makeThumbnail",
  input: ThumbnailInput,
  output: ImageInfo,
  reads: ["images"],
  changes: ["images"],
});
// #endregion thumbnail-contract

// #region definitions
export const interactions = {
  makeThumbnail: makeThumbnailInteraction,
  inspectImage: defineInteraction({
    id: "images.inspect",
    input: z.strictObject({ imageId: z.string() }),
    output: ImageInfo,
    reads: ["images"],
  }),
  deleteImage: defineInteraction({
    id: "images.delete",
    input: z.strictObject({ imageId: z.string() }),
    output: z.strictObject({ deleted: z.boolean() }),
    changes: ["images"],
  }),
};
// #endregion definitions

// #region application
type Context = Readonly<{ kind: "screen" | "script" | "agent" }>;
type StoredImage = z.infer<typeof ImageInfo> & { svg: string };
const content = '<rect width="800" height="600" fill="coral"/>'
  + '<circle cx="400" cy="300" r="180" fill="navy"/>';
function svg(width: number, height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 600">${content}</svg>`;
}
// #endregion application

export async function createThumbnailExample() {
  // #region projection
  const compiled = await compileInteractions(interactions);
  const thumbnailSurface = await projectInteractions(compiled, {
    makeThumbnail: direct(compiled.handles.makeThumbnail),
  });
  // No implementation or live installation is needed to select this surface.
  // #endregion projection

  // #region rendering-storage
  const images = new Map<string, StoredImage>([
    ["original", { imageId: "original", width: 800, height: 600, svg: svg(800, 600) }],
  ]);
  const dispatches: string[] = [];
  function lookup(imageId: string) {
    const found = images.get(imageId);
    if (!found) throw new Error(`Unknown image: ${imageId}`);
    return found;
  }
  // Application-owned rendering remains an ordinary function.
  function makeThumbnail(input: z.infer<typeof ThumbnailInput>) {
    const original = lookup(input.imageId);
    const width = Math.min(original.width, input.maxWidth);
    const height = Math.max(1, Math.round(original.height * width / original.width));
    const imageId = `${input.imageId}:w${width}`;
    images.set(imageId, { imageId, width, height, svg: svg(width, height) });
    return { imageId, width, height };
  }

  // #endregion rendering-storage

  // #region installation
  const implementations = implementInteractions<typeof interactions, Context>(interactions, {
    makeThumbnail(input) {
      dispatches.push("makeThumbnail");
      return makeThumbnail(input);
    },
    inspectImage({ imageId }) {
      dispatches.push("inspectImage");
      const { width, height } = lookup(imageId);
      return { imageId, width, height };
    },
    deleteImage({ imageId }) {
      dispatches.push("deleteImage");
      return { deleted: images.delete(imageId) };
    },
  });
  const { installation } = await installInteractions(compiled, {
    installationId: "images:local:release-1",
    implementations,
    realizationIds: directRealizationIds(compiled, "release-1"),
  });
  // #endregion installation

  // #region binding
  const admitScreenOrScript = admitWhen(
    (context: Context) => context.kind === "screen" || context.kind === "script",
    "This connection admits the screen and script",
  );
  const result = await bindProjection(thumbnailSurface, installation, {
    admit: admitScreenOrScript,
  });
  if (result.status !== "bound") {
    throw new Error("Thumbnail surface is unavailable", { cause: result.report });
  }
  const caller = result.binding.connect();
  // #endregion binding

  // #region call
  const fromScreen = () => caller.call(
    thumbnailSurface.handles.makeThumbnail,
    { imageId: "original", maxWidth: 200 },
    { kind: "screen" },
  );
  const fromScript = () => caller.call(
    thumbnailSurface.handles.makeThumbnail,
    { imageId: "original", maxWidth: 200 },
    { kind: "script" },
  );
  // #endregion call

  // #region replacement
  // A new local installation, not a remote-worker implementation.
  const { installation: replacement } = await installInteractions(compiled, {
    installationId: "images:local:release-2",
    implementations,
    realizationIds: directRealizationIds(compiled, "release-2"),
  });
  const replacementResult = await bindProjection(thumbnailSurface, replacement, {
    admit: admitScreenOrScript,
  });
  if (replacementResult.status !== "bound") {
    throw new Error("Replacement cannot satisfy caller", { cause: replacementResult.report });
  }
  // The same caller surface connects explicitly to the new installation.
  const replacementCaller = replacementResult.binding.connect();
  // #endregion replacement

  // #region mismatch
  const queuedInteractions = {
    makeThumbnail: defineInteraction({
      id: "images.makeThumbnail",
      input: ThumbnailInput,
      output: z.strictObject({ jobId: z.string() }),
      reads: ["images"],
      changes: ["images"],
    }),
  };
  const queued = await compileInteractions(queuedInteractions);
  const queuedDispatches: string[] = [];
  const { installation: queuedInstallation } = await installInteractions(queued, {
    installationId: "images:queued:release-1",
    implementations: implementInteractions<typeof queuedInteractions, Context>(queuedInteractions, {
      makeThumbnail() {
        queuedDispatches.push("makeThumbnail");
        return { jobId: "job-1" };
      },
    }),
    realizationIds: directRealizationIds(queued, "release-1"),
  });
  const mismatch = await bindProjection(thumbnailSurface, queuedInstallation, {
    admit: admitScreenOrScript,
  });
  // mismatch.status === "unrealized": a job ID does not satisfy ImageInfo.
  // Binding checks declarations without dispatching thumbnail work.
  // #endregion mismatch

  // #region agent
  const agentSurface = await projectInteractions(compiled, {
    makeThumbnail: direct(compiled.handles.makeThumbnail),
    inspectImage: direct(compiled.handles.inspectImage),
  });
  const agentResult = await bindProjection(agentSurface, installation, {
    admit: admitWhen((context: Context) => context.kind === "agent", "Agent connection required"),
  });
  if (agentResult.status !== "bound") {
    throw new Error("Agent surface is unavailable", { cause: agentResult.report });
  }
  const agent = agentResult.binding.connect();
  // No deleteImage handle is exposed. Admission still checks every call.
  // Context must come from the host's trusted caller identification.
  // #endregion agent

  return {
    fromScreen, fromScript, images, dispatches, thumbnailSurface,
    replacementCaller, mismatch, queuedDispatches,
    agent, agentSurface, agentBinding: agentResult.binding,
  };
}

// #region overview
export async function runThumbnailExample() {
  const example = await createThumbnailExample();
  const screen = await example.fromScreen();
  const script = await example.fromScript();
  // Both return { imageId: "original:w200", width: 200, height: 150 }.
  return { screen, script, mismatch: example.mismatch.status };
}
// #endregion overview
