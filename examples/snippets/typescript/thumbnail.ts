/**
 * A local executable teaching fixture. It resizes a trusted, generated SVG,
 * not an uploaded photograph. The replacement installation is in this process;
 * moving execution to a worker additionally needs a host-chosen transport.
 */
// #region imports
import { admitWhen, install, surface } from "@foxworth/boundary";
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
  // #region surface
  const thumbnailSurface = surface(interactions, { call: ["makeThumbnail"] });
  // No implementation or live installation is needed to select this surface.
  // #endregion surface

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
  const handlers = {
    makeThumbnail(input: z.infer<typeof ThumbnailInput>, _context: Context) {
      dispatches.push("makeThumbnail");
      return makeThumbnail(input);
    },
    inspectImage({ imageId }: { imageId: string }) {
      dispatches.push("inspectImage");
      const { width, height } = lookup(imageId);
      return { imageId, width, height };
    },
    deleteImage({ imageId }: { imageId: string }) {
      dispatches.push("deleteImage");
      return { deleted: images.delete(imageId) };
    },
  };
  const app = await install(interactions, {
    id: "images:local:release-1",
    version: "release-1",
    handlers,
  });
  // #endregion installation

  // #region connect
  const admitScreenOrScript = admitWhen(
    (context: Context) => context.kind === "screen" || context.kind === "script",
    "This connection admits the screen and script",
  );
  const thumbnails = await app.connect(thumbnailSurface, { admit: admitScreenOrScript });
  // #endregion connect

  // #region call
  const fromScreen = () => thumbnails.makeThumbnail(
    { imageId: "original", maxWidth: 200 },
    { kind: "screen" },
  );
  const fromScript = () => thumbnails.makeThumbnail(
    { imageId: "original", maxWidth: 200 },
    { kind: "script" },
  );
  // #endregion call

  // #region replacement
  // A new local installation, not a remote-worker implementation.
  const replacement = await install(interactions, {
    id: "images:local:release-2",
    version: "release-2",
    handlers,
  });
  // The same caller surface connects explicitly to the new installation.
  const replacementCaller = await replacement.connect(thumbnailSurface, { admit: admitScreenOrScript });
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
  const queuedDispatches: string[] = [];
  const queued = await install(queuedInteractions, {
    id: "images:queued:release-1",
    version: "release-1",
    handlers: {
      makeThumbnail(_input, _context: Context) {
        queuedDispatches.push("makeThumbnail");
        return { jobId: "job-1" };
      },
    },
  });
  const mismatch = await queued.tryConnect(thumbnailSurface, { admit: admitScreenOrScript });
  // mismatch.status === "unrealized": a job ID does not satisfy ImageInfo.
  // Connecting checks declarations without dispatching thumbnail work.
  // #endregion mismatch

  // #region agent
  const agentSurface = surface(interactions, { call: ["makeThumbnail", "inspectImage"] });
  const agent = await app.connect(agentSurface, {
    admit: admitWhen((context: Context) => context.kind === "agent", "Agent connection required"),
  });
  // No deleteImage method exists. Admission still checks every call.
  // Context must come from the host's trusted caller identification.
  // #endregion agent

  return {
    fromScreen, fromScript, images, dispatches, thumbnailSurface, thumbnails, app,
    replacementCaller, mismatch, queuedDispatches,
    agent, agentSurface,
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
