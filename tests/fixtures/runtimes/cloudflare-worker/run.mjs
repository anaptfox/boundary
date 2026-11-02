import { publishedAliases } from "../../../../scripts/build/published-aliases.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { Miniflare } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let temporary;
let output;


const publishedDirectory = () => path.join(root, "dist", "boundary");

function linkPublishedPackage(name) {
  const source = publishedDirectory();
  if (!existsSync(source)) throw new Error(`built package artifact missing: ${name}`);
  const destination = path.join(temporary, "node_modules", "@foxworth", "boundary");
  mkdirSync(path.dirname(destination), { recursive: true });
  // Copy rather than symlink: Node resolves package symlinks to the workspace
  // and would otherwise load source peers instead of this isolated artifact set.
  cpSync(source, destination, { recursive: true });
}

async function buildNativeWorker() {
  const modules = new Set();
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: publishedAliases(root),
    },
    plugins: [{
      name: "assert-published-boundary-graph",
      transform(_code, id) {
        modules.add(id);
        return null;
      },
    }],
    build: {
      emptyOutDir: true,
      outDir: output,
      target: "es2022",
      lib: {
        entry: path.join(root, "tests/fixtures/runtimes/cloudflare-worker/worker.ts"),
        formats: ["es"],
      },
      rollupOptions: { output: { entryFileNames: "worker.mjs" } },
    },
  });
  const sourcePrefixes = ["packages", "workspace"].map((directory) =>
    `${path.join(root, directory)}${path.sep}`);
  const sourceModule = [...modules].find((id) => sourcePrefixes.some((prefix) =>
    id.startsWith(prefix) && id.slice(prefix.length).includes(`${path.sep}src${path.sep}`)));
  if (sourceModule) throw new Error(`Worker bundle loaded package source instead of a built artifact: ${sourceModule}`);
  return readFileSync(path.join(output, "worker.mjs"), "utf8");
}

const proxy = `export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    const target = url.pathname.startsWith("/service/")
      ? "/" + url.pathname.slice("/service/".length)
      : url.pathname;
    return env.BOUNDARY.fetch(new Request("https://boundary.internal" + target, request));
  },
};`;

let miniflare;
try {
temporary = mkdtempSync(path.join(tmpdir(), "boundary-worker-native-"));
output = path.join(temporary, "worker");
linkPublishedPackage("boundary");
const { createHandoffInvocation } = await import(pathToFileURL(path.join(temporary, "node_modules", "@foxworth", "boundary", "dist", "handoff.js")).href);
const worker = await buildNativeWorker();
miniflare = new Miniflare({
  compatibilityDate: "2025-07-18",
  workers: [
    {
      name: "edge",
      modules: true,
      script: proxy,
      serviceBindings: { BOUNDARY: "boundary" },
    },
    {
      name: "boundary",
      modules: true,
      script: worker,
      serviceBindings: {
        ASSETS: async (request) => new Response(`asset:${new URL(request.url).pathname}`),
      },
      kvNamespaces: ["TODOS"],
    },
  ],
});
  const screenHeaders = (tenant) => ({ authorization: `Bearer fixture-${tenant}` });
  const [acme, other, denied, fallback] = await Promise.all([
    miniflare.dispatchFetch("https://example.test/boundary/acme/todos", { headers: screenHeaders("acme") }),
    miniflare.dispatchFetch("https://example.test/boundary/other/todos", { headers: screenHeaders("other") }),
    miniflare.dispatchFetch("https://example.test/boundary/acme/todos", { headers: { "x-role": "screen", "x-account": "acme" } }),
    miniflare.dispatchFetch("https://example.test/app.js"),
  ]);
  if (acme.status !== 200 || other.status !== 200 || denied.status !== 403) {
    throw new Error("matched native Worker requests did not preserve per-request admission");
  }
  if (await fallback.text() !== "asset:/app.js") {
    throw new Error("native Worker fallback did not retain application routing");
  }
  const created = await miniflare.dispatchFetch("https://example.test/boundary/acme/todos", {
    method: "POST",
    headers: { ...screenHeaders("acme"), "content-type": "application/json" },
    body: JSON.stringify({ title: "acme persisted" }),
  });
  const forgedWrite = await miniflare.dispatchFetch("https://example.test/boundary/acme/todos", {
    method: "POST",
    headers: { ...screenHeaders("other"), "content-type": "application/json" },
    body: JSON.stringify({ title: "other forged write" }),
  });
  if (!created.ok || forgedWrite.status !== 403) {
    throw new Error("native Worker did not persist an authenticated write or reject a cross-tenant write");
  }

  const manifestResponse = await miniflare.dispatchFetch(
    "https://example.test/service/handoff/manifest",
    { headers: screenHeaders("acme") },
  );
  const manifest = await manifestResponse.json();
  if (!manifestResponse.ok) throw new Error("selected Handoff manifest was unavailable through service fetch");
  const exact = await createHandoffInvocation(manifest, "todos.list", "direct", null);
  const completed = await miniflare.dispatchFetch(
    "https://example.test/service/handoff/invoke",
    { method: "POST", headers: { ...screenHeaders("acme"), "content-type": "application/json" }, body: JSON.stringify(exact) },
  );
  const outcome = await completed.json();
  if (!completed.ok || outcome.certainty !== "completed" || outcome.result?.kind !== "returned") {
    throw new Error("selected Handoff invocation did not complete through the Worker service binding");
  }
  const possessionOnly = await miniflare.dispatchFetch(
    "https://example.test/service/handoff/invoke",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(exact) },
  );
  if (possessionOnly.status !== 403) {
    throw new Error("service-binding reachability was treated as end-user Handoff authority");
  }

  const stale = await miniflare.dispatchFetch(
    "https://example.test/service/handoff/invoke",
    { method: "POST", headers: { ...screenHeaders("acme"), "content-type": "application/json" }, body: JSON.stringify({ ...exact, realizationId: "stale:realization" }) },
  );
  if (stale.status !== 409) throw new Error("stale Handoff invocation was not rejected");
  const failed = await miniflare.dispatchFetch(
    "https://example.test/service/handoff/invoke",
    { method: "POST", headers: { ...screenHeaders("acme"), "content-type": "application/json" }, body: "not-json" },
  );
  if (failed.status !== 400) throw new Error("malformed Handoff invocation was not rejected");

  // The matched acme request schedules through its native factory. This only
  // proves runtime acceptance; it does not establish durable completion/retry.
  console.log("worker-native smoke passed against built Boundary package artifacts");
} finally {
  await miniflare?.dispose();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
