// Test: packed @foxworth/boundary SDK bind offline without workspace source.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifyContentManifest,
  verifyPackReceipt,
} from "../../packages/core/artifact/integrity.ts";
import { RELEASE_FAMILY } from "../../scripts/build/sdk.ts";
import { provePortableRuntimes } from "./portable-runtimes.mjs";
import { proveBrowserConsumer } from "./browser-consumer.mjs";
import { proveArtifactConsumer } from "./artifact-consumer.mjs";
import { proveBoundaryIntegration } from "./boundary-integration.mjs";
import { proveCausalEvidenceConsumer } from "./causal-evidence-consumer.mjs";
import { proveShortPathConsumer } from "./short-path-consumer.mjs";
import { proveModuleCompositionConsumer } from "./module-composition.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageScripts = path.join(workspaceRoot, "scripts/build");
const sdkVersion = JSON.parse(readFileSync(path.join(workspaceRoot, "packages/package.json"), "utf8")).version;
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "boundary-packages-consumer-"));
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
}

function installedVersion(name) {
  const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules", name, "package.json"), "utf8"));
  return manifest.version;
}

try {
  if (!existsSync(path.join(workspaceRoot, "dist", "boundary", "package.json"))) {
    throw new Error("Built packages are missing. Run `just pack-smoke` to build and test them.");
  }
  // Use the store that installed this checkout, including custom store paths.
  const installedModules = JSON.parse(readFileSync(path.join(workspaceRoot, "node_modules/.modules.yaml"), "utf8"));
  const pnpmStore = path.dirname(installedModules.storeDir);

  const tarballs = {};
  for (const name of RELEASE_FAMILY) {
    const artifactRoot = path.join(workspaceRoot, "dist", "boundary");
    const report = JSON.parse(
      run(
        process.execPath,
        [
          path.join(packageScripts, "pack-artifact.mjs"),
          "--root",
          artifactRoot,
          "--output",
          temporaryRoot,
        ],
        { capture: true },
      ),
    );
    const expectedName = `@foxworth/${name}`;
    const verified = await verifyPackReceipt(report.receipt, {
      name: expectedName,
      version: sdkVersion,
    });
    await verifyContentManifest(artifactRoot, {
      name: expectedName,
      version: sdkVersion,
      aggregateDigest: verified.receipt.contentDigest,
    });
    tarballs[name] = verified.tarballPath;
  }

  const dependencies = Object.fromEntries(
    RELEASE_FAMILY.map((name) => [
      `@foxworth/${name}`,
      `file:${tarballs[name]}`,
    ]),
  );
  // Install only public packages and their real runtime dependencies. Optional
  // framework peers are linked from this verified workspace after install so
  // the offline smoke cannot drift to a newer transitive dependency graph.
  for (const external of [
    "@modelcontextprotocol/server",
    "@trpc/server",
    "zod",
  ]) {
    dependencies[external] = installedVersion(external);
  }
  writeFileSync(
    path.join(temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "boundary-packed-packages-consumer",
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  // pnpm 12 silently ignores --config.auto-install-peers. Keep this setting
  // in its supported YAML source so optional framework peers stay external.
  writeFileSync(
    path.join(temporaryRoot, "pnpm-workspace.yaml"),
    "autoInstallPeers: false\n",
  );
  run(
    "pnpm",
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--store-dir",
      pnpmStore,
    ],
    { cwd: temporaryRoot },
  );

  const peerRoots = {
    "@bytecodealliance/jco": path.join(workspaceRoot, "packages/node_modules/@bytecodealliance/jco"),
    electron: path.join(workspaceRoot, "packages/node_modules/electron"),
  };
  for (const peer of [
    "@types/node",
    "@types/react",
    "electron",
    "@bytecodealliance/jco",
    "hono",
    "next",
    "react",
    "typescript",
    "vite",
  ]) {
    const target = realpathSync(
      peerRoots[peer] ?? path.join(workspaceRoot, "node_modules", peer),
    );
    const destination = path.join(temporaryRoot, "node_modules", peer);
    if (existsSync(destination)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(target, destination, "dir");
  }

  cpSync(path.join(workspaceRoot, "tests/fixtures/wasm-imports/compliant.component.wasm"), path.join(temporaryRoot, "plugin.component.wasm"));
  cpSync(path.join(workspaceRoot, "tests/fixtures/wasm-imports/aliased-imports.component.wasm"), path.join(temporaryRoot, "aliased-plugin.component.wasm"));
  cpSync(path.join(workspaceRoot, "tests/fixtures/wasm-imports/instantiated-alias-imports.component.wasm"), path.join(temporaryRoot, "instantiated-plugin.component.wasm"));
  proveArtifactConsumer(temporaryRoot, `${tarballs.boundary}.receipt.json`);
  proveBoundaryIntegration(temporaryRoot);
  proveCausalEvidenceConsumer(temporaryRoot);
  proveShortPathConsumer(temporaryRoot);
  await proveModuleCompositionConsumer(temporaryRoot, `${tarballs.boundary}.receipt.json`);
  writeFileSync(path.join(temporaryRoot, "plugin-proof.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPluginExecutor, HostImports, inspectPlugin, loadPlugin } from "@foxworth/boundary/plugin";
const aliased = await inspectPlugin(
  new Uint8Array(readFileSync(new URL("./aliased-plugin.component.wasm", import.meta.url))),
  new HostImports("boundary:guest/footprints@1.0.0").provide("images"),
  "reviewed-alias-fixture",
);
assert.deepEqual(aliased.required, [
  { instance: "derived", name: "run" },
  { instance: "provider", name: "shape" },
]);
assert.deepEqual(aliased.check, {
  status: "refused", unmapped: ["derived#run", "provider#shape"], provided: ["images"],
});
const instantiated = await inspectPlugin(
  new Uint8Array(readFileSync(new URL("./instantiated-plugin.component.wasm", import.meta.url))),
  new HostImports("boundary:guest/footprints@1.0.0").provide("images"),
  "reviewed-instantiated-alias-fixture",
);
assert.deepEqual(instantiated.required, [
  { instance: "derived", name: "allowed" },
  { instance: "derived", name: "extra" },
]);
assert.deepEqual(instantiated.check, {
  status: "refused", unmapped: ["derived#allowed", "derived#extra"], provided: ["images"],
});
const executor = createPluginExecutor();
try {
  const loaded = await loadPlugin({ executor,
    bytes: new Uint8Array(readFileSync(new URL("./plugin.component.wasm", import.meta.url))),
    imports: new HostImports("boundary:guest/footprints@1.0.0").provide("images"),
    witDigest: "reviewed-compliant-fixture", host: { images: () => "{}" },
  });
  assert.equal(loaded.status, "ready", JSON.stringify(loaded));
  const outcome = await loaded.instance.call("images-make-thumbnail", "{}");
  assert.equal(outcome.status, "fault");
  assert.equal(outcome.certainty, "unknown");
  await loaded.instance.close();
} finally { await executor.close(); }
console.log("Packed plugin worker preserves unknown certainty.");
`);
  run(process.execPath, [path.join(temporaryRoot, "plugin-proof.mjs")], { cwd: temporaryRoot });

  const duplicateHostRoot = path.join(temporaryRoot, "duplicate-host-package");
  cpSync(
    path.join(temporaryRoot, "node_modules/@foxworth/boundary"),
    duplicateHostRoot,
    { recursive: true },
  );
  writeFileSync(
    path.join(temporaryRoot, "proof-runtime.mjs"),
    `import { portableSchema } from "@foxworth/boundary/program";
const PingOutput = portableSchema({
  type: "object",
  properties: { ok: { const: true } },
  required: ["ok"],
  additionalProperties: false,
});
export async function declarations(host) {
  const ping = host.defineInteraction({
    id: "packed.ping",
    output: PingOutput,
    reads: [],
    changes: [],
  });
  const interactions = Object.freeze({ ping });
  const compiled = await host.compileInteractions(interactions);
  const projection = await host.projectAllDirect(compiled);
  return { compiled, interactions, projection };
}
export async function fixture(host) {
  const { compiled, interactions } = await declarations(host);
  const implementations = host.implementInteractions(interactions, {
    ping: () => ({ ok: true }),
  });
  const { installation } = await host.installInteractions(compiled, {
    installationId: "installation:packed:1",
    implementations,
    realizationIds: { ping: { direct: "realization:packed.ping:1" } },
  });
  const projection = await host.projectInteractions(compiled, {
    ping: { interaction: compiled.handles.ping, modes: ["direct"] },
  });
  const result = await host.bindProjection(projection, installation, {
    admit: host.admitAll,
  });
  if (result.status !== "bound") throw new Error("packed proof did not bind");
  return { binding: result.binding, compiled, interactions };
}
`,
  );
  writeFileSync(
    path.join(temporaryRoot, "generate-reference.mjs"),
    `import { writeFile } from "node:fs/promises";
import { declarations, fixture } from "./proof-runtime.mjs";
const host = await import(process.argv[2]);
const build = await import(process.argv[3]);
const offline = await declarations(host);
const offlineArtifacts = build.renderHostArtifacts({ references: { offline: {
  name: "offline",
  value: {
    projection: offline.projection,
    source: { compiled: offline.compiled, module: "./proof-interactions.js", export: "interactions" },
    exportName: "offlineReferences", members: { ping: { definition: "ping" } },
  },
} } });
const offlineFile = offlineArtifacts.files.find(file => file.path === "offline.references.ts");
if (!offlineFile) throw new Error("offline reference artifact was not rendered");
await writeFile(new URL("./offline.references.ts", import.meta.url), Uint8Array.from(offlineFile.bytes));
const { binding, compiled } = await fixture(host);
const artifacts = build.renderHostArtifacts({
  references: {
    packed: {
      name: "generated",
      value: {
        binding,
        source: {
          compiled,
          module: "./proof-interactions.js",
          export: "interactions",
        },
        exportName: "generatedReferences",
        members: { ping: { definition: "ping" } },
      },
    },
  },
});
const generated = artifacts.files.find(file => file.path === "generated.references.ts");
if (!generated) throw new Error("typed reference artifact was not rendered");
await writeFile(new URL("./generated.references.ts", import.meta.url), Uint8Array.from(generated.bytes));
`,
  );
  run(
    process.execPath,
    [
      path.join(temporaryRoot, "generate-reference.mjs"),
      pathToFileURL(path.join(duplicateHostRoot, "dist", "index.js")).href,
      pathToFileURL(path.join(duplicateHostRoot, "dist", "build.js")).href,
    ],
    { cwd: temporaryRoot },
  );
  writeFileSync(
    path.join(temporaryRoot, "proof-interactions.ts"),
    `import { defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
export const interactions = {
  ping: defineInteraction({
    id: "packed.ping",
    output: portableSchema<Readonly<{ ok: true }>>({
      type: "object",
      properties: { ok: { const: true } },
      required: ["ok"],
      additionalProperties: false,
    }),
    reads: [],
    changes: [],
  }),
} as const;
`,
  );
  writeFileSync(
    path.join(temporaryRoot, "proof-usage.ts"),
    `import { createInvocationState, type ProjectionClient } from "@foxworth/boundary/client";
import { generatedReferences } from "./generated.references.js";
import { offlineReferences } from "./offline.references.js";
declare const client: ProjectionClient;
client.call(offlineReferences.ping).then(value => { const exact: true = value.ok; return exact; });
// @ts-expect-error offline references preserve zero-arity input checking
client.call(offlineReferences.ping, {});
client.call(generatedReferences.ping).then(value => {
  const exact: true = value.ok;
  return exact;
});
// @ts-expect-error zero-arity references reject an input argument
client.call(generatedReferences.ping, {});
const interaction = createInvocationState(client, generatedReferences.ping, "direct");
interaction.invoke().then(value => { const exact: true = value.ok; return exact; });
// @ts-expect-error the headless store preserves zero-arity input checking
interaction.invoke({});
// @ts-expect-error a direct-only reference does not permit proposal requests
createInvocationState(client, generatedReferences.ping, "request");
`,
  );
  writeFileSync(
    path.join(temporaryRoot, "tsconfig.proof.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          declaration: true,
          outDir: "proof-dist",
        },
        include: [
          "generated.references.ts",
          "offline.references.ts",
          "proof-interactions.ts",
          "proof-usage.ts",
        ],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [
      path.join(workspaceRoot, "node_modules/typescript/bin/tsc"),
      "--project",
      path.join(temporaryRoot, "tsconfig.proof.json"),
    ],
    { cwd: temporaryRoot },
  );
  writeFileSync(
    path.join(temporaryRoot, "execute-reference.mjs"),
    `import * as host from "@foxworth/boundary";
import { createProjectionClient, watchInteraction } from "@foxworth/boundary/client";
import { createProtocolHandler, fetchTransport } from "@foxworth/boundary/http/protocol";
import { generatedReferences } from "./proof-dist/generated.references.js";
import { offlineReferences } from "./proof-dist/offline.references.js";
import { createInvocationState, pinProjectionReferences } from "@foxworth/boundary/client";
import { fixture } from "./proof-runtime.mjs";
const { binding } = await fixture(host);
const protocol = createProtocolHandler({
  binding,
  context: () => undefined,
  path: "/_boundary",
});
const client = createProjectionClient(fetchTransport({
  baseUrl: "https://example.test/_boundary",
  fetch: (input, init) => protocol(new Request(input, init)),
}));
const value = await client.call(generatedReferences.ping);
if (value.ok !== true) throw new Error("generated reference call returned the wrong value");
const watchedPing = watchInteraction(client, generatedReferences.ping);
if ((await watchedPing.refresh()).ok !== true) throw new Error("packed watch returned the wrong value");
watchedPing.dispose();
const pinned = await pinProjectionReferences(client, offlineReferences);
if ((await client.call(pinned.ping)).ok !== true) throw new Error("offline reference call returned the wrong value");
const interaction = createInvocationState(client, pinned.ping, "direct");
if (interaction.getSnapshot().phase !== "idle") throw new Error("packed interaction was not inert");
if ((await interaction.invoke()).ok !== true || interaction.getSnapshot().phase !== "succeeded") {
  throw new Error("packed interaction did not preserve its completed outcome");
}
interaction.disconnect();
let disconnected = false;
try { await interaction.invoke(); } catch { disconnected = true; }
if (!disconnected) throw new Error("disconnected packed interaction allowed another invocation");
interaction.dispose();
console.log("packed duplicate-instance binding and offline references executed bound calls");
`,
  );
  run(process.execPath, [path.join(temporaryRoot, "execute-reference.mjs")], {
    cwd: temporaryRoot,
  });
  writeFileSync(path.join(temporaryRoot, "observed-read-proof.mjs"), `
import assert from "node:assert/strict";
import * as host from "@foxworth/boundary";
import { observedRead } from "@foxworth/boundary/observations";
import { portableSchema } from "@foxworth/boundary/program";
const definitions = {
  get: host.defineInteraction({
    id: "packed.documents.get",
    input: portableSchema({ type: "object", properties: { id: { const: "doc-1" } }, required: ["id"], additionalProperties: false }),
    output: portableSchema({ type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }),
    reads: ["documents"], changes: [],
  }),
};
let title = "first";
let present = true;
let evaluations = 0;
let authorizations = 0;
let admissions = 0;
const events = [];
const snapshots = {
  async withSnapshot(_context, _scope, run) {
    const value = present ? Object.freeze({ title }) : undefined;
    const token = JSON.stringify(value === undefined ? { kind: "absent" } : { kind: "present", value });
    return run({
      read(key) {
        assert.equal(key, "doc-1");
        return value === undefined ? { kind: "absent", token } : { kind: "present", value, token };
      },
      query() { throw new Error("this adapter supports point reads only"); },
      validate(observation) {
        assert.equal(observation.kind, "point");
        return observation.token === token ? "matching" : "changed";
      },
    });
  },
};
const implementations = host.implementInteractions(definitions, {
  get: observedRead(definitions.get, {
    snapshots,
    scope: () => "public-documents",
    authorize() { authorizations++; },
    async evaluate(input, view) {
      evaluations++;
      const read = await view.read(input.id);
      return read.kind === "present" ? read.value : { title: "missing" };
    },
    reuse: "validated",
    diagnostic(event) { events.push(event); },
  }),
});
const compiled = await host.compileInteractions(definitions);
const { installation } = await host.installInteractions(compiled, {
  installationId: "installation:packed:observed",
  implementations,
  realizationIds: { get: { direct: "realization:packed:observed" } },
});
const projection = await host.projectAllDirect(compiled);
const parent = await host.bindProjection(projection, installation, {
  admit() { admissions++; return { decision: "allow" }; },
});
assert.equal(parent.status, "bound");
const child = await host.restrictBinding(parent.binding, { projection, admit: host.admitAll });
assert.equal(child.status, "bound");
assert.equal(child.binding.manifest.bindingDigest, parent.binding.manifest.bindingDigest);
const caller = child.binding.connect();
assert.deepEqual(await caller.call(projection.handles.get, { id: "doc-1" }), { title: "first" });
assert.deepEqual(await caller.call(projection.handles.get, { id: "doc-1" }), { title: "first" });
assert.equal(evaluations, 1);
title = "changed";
assert.deepEqual(await caller.call(projection.handles.get, { id: "doc-1" }), { title: "changed" });
assert.equal(evaluations, 2);
present = false;
assert.deepEqual(await caller.call(projection.handles.get, { id: "doc-1" }), { title: "missing" });
assert.equal(evaluations, 3);
assert.equal(admissions, 4);
assert.equal(authorizations, 4);
assert.deepEqual(events.map(event => event.reused), [false, true, false, false]);
parent.controller.revoke();
await assert.rejects(() => caller.call(projection.handles.get, { id: "doc-1" }), error => error.cause === "revoked");
assert.equal(authorizations, 4);
console.log("Packed observed reads validate point evidence, refresh authorization, and retain restriction lifecycle.");
`);
  run(process.execPath, [path.join(temporaryRoot, "observed-read-proof.mjs")], {
    cwd: temporaryRoot,
  });
  provePortableRuntimes(
    temporaryRoot,
    workspaceRoot,
    process.argv.includes("--portable-runtimes"),
  );
  await proveBrowserConsumer(temporaryRoot);

  const specifiers = [
    "@foxworth/boundary/program",
    "@foxworth/boundary/program/zod",
    "@foxworth/boundary/observations",
    "@foxworth/boundary",
    "@foxworth/boundary/build",
    "@foxworth/boundary/artifact",
    "@foxworth/boundary/handoff",
    "@foxworth/boundary/control",
    "@foxworth/boundary/control/host",
    "@foxworth/boundary/control/testing",
    "@foxworth/boundary/client/cache",
    "@foxworth/boundary/client",
    "@foxworth/boundary/remote",
    "@foxworth/boundary/http",
    "@foxworth/boundary/http/compose",
    "@foxworth/boundary/http/openapi",
    "@foxworth/boundary/http/protocol",
    "@foxworth/boundary/frameworks/trpc",
    "@foxworth/boundary/http/node",
    "@foxworth/boundary/frameworks/hono",
    "@foxworth/boundary/frameworks/next",
    "@foxworth/boundary/frameworks/vite",
    "@foxworth/boundary/mcp",
    "@foxworth/boundary/webmcp",
    "@foxworth/boundary/react",
    "@foxworth/boundary/cloudflare",
    "@foxworth/boundary/electron",
    "@foxworth/boundary/reach",
    "@foxworth/boundary/bus",
    "@foxworth/boundary/plugin",
  ];
  writeFileSync(
    path.join(temporaryRoot, "runtime.mjs"),
    `const specifiers = ${JSON.stringify(specifiers)};\nfor (const specifier of specifiers) {\n  const loaded = await import(specifier);\n  if (!loaded || typeof loaded !== "object") throw new Error(\`failed to import \${specifier}\`);\n}\n`,
  );
  run(process.execPath, [path.join(temporaryRoot, "runtime.mjs")], {
    cwd: temporaryRoot,
  });

  const workerdSmoke = path.join(temporaryRoot, "mcp-frozen-schema-workerd-smoke.mjs");
  writeFileSync(
    workerdSmoke,
    readFileSync(
      path.join(workspaceRoot, "tests/process/mcp-workerd-schema.mjs"),
      "utf8",
    ),
  );
  run(process.execPath, ["--conditions=workerd", workerdSmoke], {
    cwd: temporaryRoot,
  });

  writeFileSync(
    path.join(temporaryRoot, "types.ts"),
    `${specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`).join("\n")}\nexport const modules = [${specifiers.map((_value, index) => `m${index}`).join(", ")}];\n`,
  );
  cpSync(path.join(workspaceRoot, "tests/typescript/native-dispatch.types.ts"), path.join(temporaryRoot, "integration.types.ts"));
  writeFileSync(
    path.join(temporaryRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["types.ts", "integration.types.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [
      path.join(workspaceRoot, "node_modules/typescript/bin/tsc"),
      "--project",
      path.join(temporaryRoot, "tsconfig.json"),
    ],
    { cwd: temporaryRoot },
  );

  for (const name of RELEASE_FAMILY) {
    const installed = realpathSync(
      path.join(temporaryRoot, `node_modules/@foxworth/${name}`),
    );
    if (["packages", "workspace"].some((directory) =>
      installed.startsWith(`${path.join(workspaceRoot, directory)}${path.sep}`))) {
      throw new Error(`packed ${name} resolved to workspace source`);
    }
    const manifest = JSON.parse(
      readFileSync(path.join(installed, "package.json"), "utf8"),
    );
    if (manifest.private || manifest.publishConfig?.access !== "public") {
      throw new Error(`${name} artifact is not public`);
    }
  }
  const stylesheet = path.join(
    temporaryRoot,
    "node_modules/@foxworth/boundary/dist/react/styles.css",
  );
  if (!existsSync(stylesheet)) {
    throw new Error("packed react-ui stylesheet is missing");
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
