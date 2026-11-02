import { publishedAliases } from "../../../../scripts/build/published-aliases.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const root = await mkdtemp(join(repoRoot, ".vite-native-smoke-"));
const entryPath = join(root, "serving.mjs");
const cleanupPath = join(root, "cleanup.log");
const statePath = join(root, "todos.json");
const indexPath = join(root, "index.html");
const configPath = join(root, "vite.config.ts");
const diagnosticPath = join(root, "diagnostic.json");
let diagnostic;
let server;
let preview;
let serverUrl;
let frontendEdit = 0;

const fixture = (generation) => `
import { readFile, writeFile } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { z } from ${JSON.stringify(join(repoRoot, "node_modules/zod/index.js"))};
import { admitAll, bindProjection, compileInteractions, defineInteraction, directRealizationIds, implementInteractions, installInteractions, projectInteractions } from ${JSON.stringify(join(repoRoot, "dist/boundary/dist/index.js"))};
import { createHttpHandler, route } from ${JSON.stringify(join(repoRoot, "dist/boundary/dist/http.js"))};
const todo = z.strictObject({ id: z.number().int(), title: z.string(), completed: z.boolean() });
const interactions = { list: defineInteraction({ id: "vite.todos.list", description: "List persisted Vite-native todos.", output: z.array(todo), reads: ["vite.todos"], changes: [] }), create: defineInteraction({ id: "vite.todos.create", description: "Create a persisted Vite-native todo.", input: z.strictObject({ title: z.string().min(1) }), output: todo, reads: ["vite.todos"], changes: ["vite.todos"] }) };
async function createHost(path) {
  let todos = [];
  try { todos = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let nextId = Math.max(0, ...todos.map((item) => item.id)) + 1;
  const compiled = await compileInteractions(interactions);
  const projection = await projectInteractions(compiled, { list: { interaction: compiled.handles.list, modes: ["direct"] }, create: { interaction: compiled.handles.create, modes: ["direct"] } });
  const implementations = implementInteractions(interactions, { list: () => [...todos], async create(input) { const created = { id: nextId++, title: input.title, completed: false }; todos.push(created); await writeFile(path, JSON.stringify(todos), "utf8"); return created; } });
  const { installation } = await installInteractions(compiled, { installationId: "vite-native:todos:v1", implementations, realizationIds: directRealizationIds(compiled, "vite-native") });
  const result = await bindProjection(projection, installation, { admit: admitAll });
  if (result.status !== "bound") throw new Error("fixture binding was not realized");
  return createHttpHandler({ binding: result.binding, context: () => undefined, routes: [route(projection.handles.list, { method: "GET", path: "/_boundary/todos" }), route(projection.handles.create, { method: "POST", path: "/_boundary/todos" })] });
}
export function createCandidate({ cleanupPath }) {
  const hostPromise = createHost(${JSON.stringify(statePath)});
  return {
    generation: ${JSON.stringify(generation)},
    handler: async (request) => (await hostPromise)(request),
    dispose: async () => {
      await appendFile(cleanupPath, ${JSON.stringify(generation + String.fromCharCode(10))});
    },
  };
}
`;

const failedFixture = `
import { appendFile } from "node:fs/promises";
export function createCandidate({ cleanupPath }) {
  return {
    generation: "bad",
    handler: async () => new Response("bad"),
    dispose: async () => {
      await appendFile(cleanupPath, ${JSON.stringify("bad" + String.fromCharCode(10))});
    },
  };
}
`;

async function writeFixture(value) {
  await writeFile(entryPath, value, "utf8");
  await writeFrontendEdit();
}

async function writeFrontendEdit() {
  await writeFile(
    indexPath,
    `<!doctype html><html><body><h1>Vite native</h1><script type="module" src="/serving.mjs"></script><!-- edit ${++frontendEdit} --></body></html>`,
    "utf8",
  );
}

async function writeConfig() {
  const adapterPath = join(repoRoot, "packages/adapters/frameworks/vite.ts");
  await writeFile(
    configPath,
    `
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import { mountProjectionLifecycle } from ${JSON.stringify(adapterPath)};

const entryPath = ${JSON.stringify(entryPath)};
const cleanupPath = ${JSON.stringify(cleanupPath)};
const diagnosticPath = ${JSON.stringify(diagnosticPath)};
let revision = 0;
let preparedHandler = globalThis.__boundaryVitePreparedHandler;
export default defineConfig({
  plugins: [mountProjectionLifecycle({
    mount: "/_boundary",
    watch: entryPath,
    entry: async ({ signal, mode, loadModule }) => {
      if (signal.aborted) throw new Error("entry aborted");
      if (mode === "preview" && preparedHandler) return {
        generation: "preview",
        handler: preparedHandler,
        dispose: async () => {
          const fs = await import("node:fs/promises");
          await fs.appendFile(cleanupPath, "preview\\n");
        },
      };
      const module = loadModule
        ? await loadModule(entryPath + "?revision=" + (++revision))
        : await import(pathToFileURL(entryPath).href + "?revision=" + (++revision));
      const candidate = module.createCandidate({ cleanupPath });
      preparedHandler = candidate.handler;
      if (candidate.generation !== "bad") globalThis.__boundaryVitePreparedHandler = preparedHandler;
      return candidate;
    },
    validate: ({ generation }) => {
      if (generation === "bad") throw new Error("candidate contract is invalid");
    },
    onDiagnostic: (value) => writeFileSync(diagnosticPath, JSON.stringify({ ...value, ...(value.cause instanceof Error ? { cause: String(value.cause) } : {}) })),
  })],
  resolve: { alias: ${JSON.stringify(publishedAliases(repoRoot).map(({ find, replacement }) => ({ find: find.source.slice(1, -1).replaceAll("\\", ""), replacement })))} },
  ssr: { noExternal: true },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
`,
    "utf8",
  );
}

async function request(expectedGeneration) {
  const response = await fetch(`${serverUrl}/_boundary`, {
    headers: expectedGeneration ? { "x-boundary-vite-generation": expectedGeneration } : {},
  });
  const body = await response.json();
  return { response, body };
}

async function domainRequest(method, body) {
  const response = await fetch(`${serverUrl}/_boundary/todos`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- body is only set for non-GET calls
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, body: await response.json() };
}

async function eventually(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  let diagnosticText = "";
  try { diagnosticText = ` diagnostic=${await readFile(diagnosticPath, "utf8")}`; } catch {}
  throw new Error(`${label}: ${lastError?.message ?? "condition did not become true"}${diagnosticText}`);
}

let primaryError;
try {
  process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = "true";
  await writeFile(indexPath, `<!doctype html><html><body><h1>Vite native</h1><script type="module" src="/serving.mjs"></script></body></html>`, "utf8");
  await writeFixture(fixture("g1"));
  await writeConfig();
  server = await createServer({
    root,
    configFile: configPath,
    appType: "spa",
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.equal(typeof address, "object");
  serverUrl = `http://127.0.0.1:${address.port}`;
  const entryResponse = await fetch(`${serverUrl}/serving.mjs`);
  assert.equal(entryResponse.status, 200);

  const first = await eventually(async () => {
    const result = await domainRequest("GET");
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.result.kind, "returned");
    return result;
  }, "startup generation");
  assert.equal(first.response.headers.get("x-boundary-vite-generation"), "g1");
  const created = await domainRequest("POST", { title: "Persist through Vite replacement" });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.result.kind, "returned");

  await writeFrontendEdit();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterFrontendEdit = await domainRequest("GET");
  assert.equal(afterFrontendEdit.body.result.kind, "returned");

  await writeFixture(fixture("g2"));
  await eventually(async () => {
    const result = await request("g1");
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, "STALE_CLIENT");
  }, "implementation replacement and stale client");
  await eventually(async () => {
    const result = await domainRequest("GET");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.kind, "returned");
    assert.equal(result.body.result.value[0].title, "Persist through Vite replacement");
  }, "replacement generation");

  await writeFixture(failedFixture);
  await eventually(async () => {
    diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8"));
    assert.equal(diagnostic.code, "CANDIDATE_REJECTED");
    const result = await domainRequest("GET");
    assert.equal(result.body.result.value[0].title, "Persist through Vite replacement");
  }, "failed candidate retention");

  await writeFixture(fixture("g3"));
  await eventually(async () => {
    const result = await domainRequest("GET");
    assert.equal(result.body.result.value[0].title, "Persist through Vite replacement");
    assert.equal(result.response.headers.get("x-boundary-vite-generation"), "g3");
  }, "candidate recovery");
} catch (error) {
  primaryError = error;
}

let closeError;
try {
  if (server) await server.close();
} catch (error) {
  closeError = error;
}
try {
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  await eventually(async () => {
    const cleanup = (await readFile(cleanupPath, "utf8")).trim().split("\n").sort();
    assert.deepEqual(cleanup, ["bad", "g1", "g2", "g3"]);
  }, "development close cleanup", 5000);
  await writeFixture(fixture("preview"));
  preview = await (await import("vite")).preview({ root, configFile: configPath, appType: "spa" });
  const previewAddress = preview.httpServer?.address();
  assert.equal(typeof previewAddress, "object");
  serverUrl = `http://127.0.0.1:${previewAddress.port}`;
  const previewResult = await eventually(async () => {
    const result = await domainRequest("GET");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.value[0].title, "Persist through Vite replacement");
    return result;
  }, "preview startup");
  assert.equal(previewResult.response.headers.get("x-boundary-vite-generation"), "preview");
  await preview.close();
  preview = undefined;
  await eventually(async () => {
    const cleanup = await readFile(cleanupPath, "utf8");
    assert.deepEqual(cleanup.trim().split("\n").sort(), ["bad", "g1", "g2", "g3", "preview"]);
  }, "close cleanup", 5000);
} finally {
  await preview?.close();
  await rm(root, { recursive: true, force: true });
}

console.log("vite-native-smoke: startup, replacement, stale rejection, failure retention, recovery, and close cleanup passed");
