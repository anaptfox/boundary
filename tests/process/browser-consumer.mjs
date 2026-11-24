import { writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";

/** Bundle only supported browser entry points from the installed tarballs. */
export async function proveBrowserConsumer(consumerRoot) {
  const entry = path.join(consumerRoot, "browser-consumer.mjs");
  writeFileSync(entry, `
export { createProjectionClient, createInvocationState, createProposalInteraction }
  from "@foxworth/boundary/client";
export { watchInteraction } from "@foxworth/boundary/client";
export { subscribeToObservations } from "@foxworth/boundary/client";
export { useInvocationState, useProposalInteraction } from "@foxworth/boundary/react";
`);
  const result = await build({
    root: consumerRoot,
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry, formats: ["es"] },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((part) => part.output ?? []);
  const chunks = outputs.filter((output) => output.type === "chunk");
  if (chunks.length === 0) throw new Error("browser consumer produced no JavaScript");
  for (const chunk of chunks) {
    for (const [id, module] of Object.entries(chunk.modules)) {
      if (module.renderedLength === 0) continue;
      if (/__vite-browser-external|(?:^|\/)control\/|node:/.test(id)) {
        throw new Error(`browser consumer retained a server-only module: ${id}`);
      }
    }
    if (/\b(?:function|class)\s+(?:installInteractions|implementInteractions|createControlCapabilities|createControlAdmin|executeControl|grantControl)\b/.test(chunk.code)) {
      throw new Error("browser consumer retained host implementation or Control administration");
    }
  }
  console.log("packed browser client/store/React bundle excludes host installation and Control administration");
}
