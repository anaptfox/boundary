// Test: projector adapters mount on Hono, workerd, Next, and Vite.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { RELEASE_FAMILY } from "../../scripts/build/sdk.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mode = process.argv[2];
if (mode !== "build" && mode !== "live") {
  throw new Error("framework adapter test requires either `build` or `live`");
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), `boundary-framework-${mode}-`),
);
const modulesRoot = path.join(temporaryRoot, "node_modules");

function link(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`framework smoke dependency is missing: ${source}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(realpathSync(source), destination, "dir");
}

function linkPackage(name, source) {
  link(source, path.join(modulesRoot, ...name.split("/")));
}

function runNode(file, cwd = temporaryRoot) {
  execFileSync(process.execPath, [file], {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  });
}

function installHarnessModules() {
  for (const name of RELEASE_FAMILY) {
    linkPackage(
      `@foxworth/${name}`,
      path.join(workspaceRoot, "dist", "boundary"),
    );
  }
  for (const [name, source] of [
    ["vite", path.join(workspaceRoot, "node_modules/vite")],
    ["hono", path.join(workspaceRoot, "node_modules/hono")],
    ["next", path.join(workspaceRoot, "node_modules/next")],
    ["react", path.join(workspaceRoot, "node_modules/react")],
    ["react-dom", path.join(workspaceRoot, "node_modules/react-dom")],
    ["typescript", path.join(workspaceRoot, "node_modules/typescript")],
    ["@types/node", path.join(workspaceRoot, "node_modules/@types/node")],
    ["@types/react", path.join(workspaceRoot, "node_modules/@types/react")],
    ["@types/react-dom", path.join(workspaceRoot, "node_modules/@types/react-dom")],
  ]) {
    linkPackage(name, source);
  }
}

function write(relative, source) {
  const file = path.join(temporaryRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

async function smokeHono() {
  const file = write(
    "hono-smoke.mjs",
    `import { Hono } from "hono";
import { mountProjection } from "@foxworth/boundary/frameworks/hono";
const app = new Hono();
app.use("/boundary/*", mountProjection(async request =>
  Response.json({ path: new URL(request.url).pathname, runtime: "hono" })
));
const response = await app.request("https://example.test/boundary/hello");
if (response.status !== 200) throw new Error("Hono mount returned " + response.status);
const value = await response.json();
if (value.path !== "/boundary/hello" || value.runtime !== "hono") {
  throw new Error("Hono mount changed the injected handler request");
}
`,
  );
  runNode(file);
}

async function smokeCloudflare() {
  const entry = write(
    "cloudflare/worker.mjs",
    `import {
  createProjectionDurableObject,
  createProjectionWorkerFetch,
} from "@foxworth/boundary/cloudflare";
const handler = async request => Response.json({
  path: new URL(request.url).pathname,
  runtime: "workerd",
});
const workerFetch = createProjectionWorkerFetch(handler, { mount: "/boundary" });
export const ProjectionObject = createProjectionDurableObject(() => handler);
export default {
  async fetch(request, environment, execution) {
    if (new URL(request.url).pathname === "/object") {
      const id = environment.PROJECTION.idFromName("proof");
      return environment.PROJECTION.get(id).fetch(
        new Request("https://example.test/boundary/object"),
      );
    }
    return workerFetch(request, environment, execution);
  },
};
`,
  );
  const output = path.join(temporaryRoot, "cloudflare/dist");
  await build({
    configFile: false,
    logLevel: "silent",
    root: temporaryRoot,
    build: {
      emptyOutDir: true,
      outDir: output,
      target: "es2022",
      lib: { entry, formats: ["es"] },
      rollupOptions: { output: { entryFileNames: "worker.mjs" } },
    },
  });
  const miniflare = new Miniflare({
    compatibilityDate: "2025-07-18",
    durableObjects: { PROJECTION: "ProjectionObject" },
    modules: true,
    script: readFileSync(path.join(output, "worker.mjs"), "utf8"),
  });
  try {
    const worker = await miniflare.dispatchFetch(
      "https://example.test/boundary/worker",
    );
    const workerValue = await worker.json();
    if (
      worker.status !== 200 ||
      workerValue.path !== "/boundary/worker" ||
      workerValue.runtime !== "workerd"
    ) {
      throw new Error("Cloudflare Worker mount did not preserve the handler");
    }
    const durable = await miniflare.dispatchFetch(
      "https://example.test/object",
    );
    const durableValue = await durable.json();
    if (
      durable.status !== 200 ||
      durableValue.path !== "/boundary/object" ||
      durableValue.runtime !== "workerd"
    ) {
      throw new Error("Durable Object mount did not preserve the handler");
    }
  } finally {
    await miniflare.dispose();
  }
}

function smokeNextBuild() {
  const nextRoot = path.join(temporaryRoot, "next-app");
  mkdirSync(nextRoot, { recursive: true });
  symlinkSync(modulesRoot, path.join(nextRoot, "node_modules"), "dir");
  writeFileSync(
    path.join(nextRoot, "package.json"),
    `${JSON.stringify({ name: "boundary-next-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(nextRoot, "next.config.mjs"),
    "export default { poweredByHeader: false };\n",
  );
  writeFileSync(
    path.join(nextRoot, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"] }, null, 2)}\n`,
  );
  write("next-app/app/layout.tsx", `import type { ReactNode } from "react";\nexport default function Layout({ children }: { children: ReactNode }) { return <html><body>{children}</body></html>; }\n`);
  write("next-app/app/page.tsx", `export default function Page() { return <main>Boundary Next smoke</main>; }\n`);
  write(
    "next-app/app/api/boundary/route.ts",
    `import { createProjectionHandlers } from "@foxworth/boundary/frameworks/next";
const handler = async (request: Request) => Response.json({ method: request.method });
export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } =
  createProjectionHandlers(handler);
`,
  );
  execFileSync(
    process.execPath,
    // The harness deliberately links verified package outputs from the
    // workspace. Next's webpack builder supports that external symlink layout;
    // Turbopack rejects it before compiling the route.
    [path.join(modulesRoot, "next/dist/bin/next"), "build", "--webpack"],
    {
      cwd: nextRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
    },
  );
  if (!existsSync(path.join(nextRoot, ".next/server/app/api/boundary/route.js"))) {
    throw new Error("Next build did not emit the injected-handler route");
  }
}

function smokeViteLive() {
  const file = write(
    "vite-live.mjs",
    `import { createServer } from "vite";
import { mountProjection } from "@foxworth/boundary/frameworks/vite";
const server = await createServer({
  configFile: false,
  appType: "custom",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [mountProjection({
    mount: "/boundary",
    handler: async request => Response.json({
      method: request.method,
      runtime: "vite",
    }),
  })],
});
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind TCP");
  const response = await fetch("http://127.0.0.1:" + address.port + "/boundary/proof");
  const value = await response.json();
  if (response.status !== 200 || value.runtime !== "vite" || value.method !== "GET") {
    throw new Error("Vite live mount did not preserve the handler");
  }
} finally {
  await server.close();
}
`,
  );
  runNode(file);
}

try {
  installHarnessModules();
  if (mode === "build") {
    await smokeHono();
    await smokeCloudflare();
    smokeNextBuild();
    console.log("framework smoke: Hono, Cloudflare Worker/DO, and Next build passed");
  } else {
    smokeViteLive();
    console.log("live framework smoke: Vite localhost passed");
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
