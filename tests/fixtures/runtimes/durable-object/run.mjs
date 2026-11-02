import { publishedAliases } from "../../../../scripts/build/published-aliases.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";
import { Miniflare } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "boundary-do-native-"));
const persistence = path.join(temporaryRoot, "durable-objects");
const publicEntries = Object.freeze(publishedAliases(root));

async function publicAliases() {
  await Promise.all(publicEntries.map(async ({ replacement }) => {
    try {
      await access(replacement);
    } catch {
      throw new Error(`missing public package artifact: ${replacement}`);
    }
  }));
  return publicEntries;
}

async function bundle(name, entry) {
  const output = path.join(temporaryRoot, name);
  const alias = await publicAliases();
  const digest = createHash("sha256");
  const files = ["tests/fixtures/runtimes/durable-object/worker.ts", "tests/fixtures/runtimes/durable-object/controlJournal.ts", "tests/fixtures/runtimes/durable-object/run.mjs", "pnpm-lock.yaml"];
  // Pin the built dependency cut too: app-source identity alone would miss a
  // changed Host/Control implementation with the same public contract.
  for (const directory of new Set(alias.map(({ replacement }) => path.dirname(replacement)))) {
    for (const relative of await readdir(directory, { recursive: true })) {
      if (relative.endsWith(".js")) files.push(path.relative(root, path.join(directory, relative)));
    }
  }
  for (const file of [...new Set(files)].sort()) {
    digest.update(JSON.stringify([file, await readFile(path.join(root, file), "utf8")]));
  }
  const sourceHash = digest.digest("hex");
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: [{
      name: "reject-workspace-package-source",
      generateBundle() {
        const sourcePrefixes = ["packages", "workspace"].map((directory) =>
          `${path.join(root, directory)}${path.sep}`);
        for (const moduleId of this.getModuleIds()) {
          if (sourcePrefixes.some((prefix) => moduleId.startsWith(prefix)
            && moduleId.slice(prefix.length).includes(`${path.sep}src${path.sep}`))) {
            throw new Error(`native smoke bundled workspace package source: ${moduleId}`);
          }
        }
      },
    }],
    resolve: { alias },
    define: entry === "tests/fixtures/runtimes/durable-object/worker.ts"
      ? { __WORKSPACE_CONTROL_ARTIFACT_DIGEST__: JSON.stringify(`sha256:${sourceHash}`) }
      : {},
    build: {
      emptyOutDir: true,
      outDir: output,
      target: "es2022",
      lib: { entry: path.join(root, entry), formats: ["es"] },
      rollupOptions: {
        external: ["cloudflare:workers"],
        output: { entryFileNames: "entry.mjs" },
      },
    },
  });
  return path.join(output, "entry.mjs");
}

function miniflare(script, deploymentId) {
  return new Miniflare({
    bindings: { DEPLOYMENT_ID: deploymentId },
    compatibilityDate: "2025-07-18",
    durableObjects: { WORKSPACE: { className: "Workspace", useSQLite: true } },
    durableObjectsPersist: persistence,
    modules: true,
    script,
  });
}

async function request(instance, suffix, options = {}, workspaceId = "acme") {
  const headers = new Headers({ authorization: "Bearer fixture-owner" });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return instance.dispatchFetch(`https://workspace.test/workspaces/${workspaceId}${suffix}`, {
    ...options,
    headers,
  });
}

async function json(instance, suffix, body, workspaceId = "acme") {
  const response = await request(instance, suffix, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, workspaceId);
  if (!response.ok) {
    throw new Error(`${suffix} returned ${response.status}: ${(await response.text()).slice(0, 4000)}`);
  }
  return response.json();
}

async function waitForReceipt(instance, proposalId) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const status = await json(instance, `/control/status/${proposalId}`);
    if (status.receipt) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const receipts = await json(instance, "/control/alarm-receipts");
  throw new Error(`workerd did not deliver the Durable Object alarm within 65 seconds: ${JSON.stringify(receipts)}`);
}

async function waitForAlarmDeliveries(instance, attemptId, count) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const receipts = await json(instance, "/control/alarm-receipts");
    if (receipts.filter((receipt) => receipt.attemptId === attemptId).length >= count) return receipts;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`workerd did not deliver ${count} alarms for ${attemptId}`);
}

function nextSocketMessage(socket) {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
  });
}

async function openObservation(instance, workspaceId) {
  const response = await request(instance, "/observe", { headers: { Upgrade: "websocket" } }, workspaceId);
  assert.equal(response.status, 101);
  assert.ok(response.webSocket);
  const initial = nextSocketMessage(response.webSocket);
  response.webSocket.accept();
  return { socket: response.webSocket, initial: await initial };
}

async function assertNoSocketMessage(socket, duration = 100) {
  let received = false;
  const listener = () => { received = true; };
  socket.addEventListener("message", listener);
  await new Promise((resolve) => setTimeout(resolve, duration));
  socket.removeEventListener("message", listener);
  assert.equal(received, false);
}

try {
  const [workerEntry, clientEntry] = await Promise.all([
    bundle("worker", "tests/fixtures/runtimes/durable-object/worker.ts"),
    bundle("client", "tests/fixtures/runtimes/durable-object/smoke-client.ts"),
  ]);
  const worker = await readFile(workerEntry, "utf8");
  assert.match(worker, /cloudflare:workers/u);
  const { invokeFrom, readFrom } = await import(pathToFileURL(clientEntry).href);

  const first = miniflare(worker, "deployment-one");
  let originalInvocation;
  try {
    assert.equal(await json(first, "/attach", undefined), "initialized");
    const acmeObservation = await openObservation(first, "acme");
    assert.equal(acmeObservation.initial.workspaceId, "acme");
    const manifest = await (await request(first, "/boundary/manifest")).json();
    originalInvocation = await invokeFrom(manifest, 2, "request");
    const invoked = await json(first, "/boundary/invoke", originalInvocation);
    assert.equal(invoked.result.kind, "proposed");
    const firstProposal = invoked.result.proposal;
    await json(first, `/control/approve/${firstProposal.id}`);
    const firstGrant = await json(first, `/control/grant/${firstProposal.id}`);
    const firstWorkspaceEvent = nextSocketMessage(acmeObservation.socket);
    const firstResult = await json(first, `/control/execute/${firstGrant.id}`);
    assert.equal(firstResult.status, "completed");
    assert.deepEqual(await firstWorkspaceEvent, { kind: "workspace.incremented", count: 2 });

    acmeObservation.socket.close(1000, "reconnect");
    const reconnected = await openObservation(first, "acme");
    const snapshot = nextSocketMessage(reconnected.socket);
    reconnected.socket.send("snapshot");
    assert.deepEqual(await snapshot, { kind: "workspace.snapshot", count: 2 });

    assert.equal(await json(first, "/attach", undefined, "other"), "initialized");
    const otherObservation = await openObservation(first, "other");
    assert.equal(otherObservation.initial.workspaceId, "other");
    const otherManifest = await (await request(first, "/boundary/manifest", {}, "other")).json();
    const otherInvocation = await invokeFrom(otherManifest, 3, "request");
    const otherInvoked = await json(first, "/boundary/invoke", otherInvocation, "other");
    assert.equal(otherInvoked.result.kind, "proposed");

    const crossWorkspace = await request(first, "/boundary/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(otherInvocation),
    });
    assert.equal(crossWorkspace.status, 409);
    await crossWorkspace.text();

    // Request mode is the same workspace.increment declaration. The application
    // owns the administrative boundary and persists Control records in the DO.
    const requestInvocation = await invokeFrom(manifest, 4, "request");
    const proposed = await json(first, "/boundary/invoke", requestInvocation);
    assert.equal(proposed.result.kind, "proposed");
    const proposal = proposed.result.proposal;
    assert.equal(proposal.interactionId, "workspace.increment");
    const approval = await json(first, `/control/approve/${proposal.id}`);
    const grant = await json(first, `/control/grant/${proposal.id}`);
    assert.equal(approval.proposalDigest, proposal.proposalDigest);
    assert.equal(grant.proposalDigest, proposal.proposalDigest);

    // This application test seam loses only the post-commit acknowledgement.
    // The durable effect ledger remains the evidence; the counter itself is not.
    const controlledWorkspaceEvent = nextSocketMessage(reconnected.socket);
    const uncertain = await json(first, `/control/execute/${grant.id}?lose-ack=1`);
    assert.equal(uncertain.status, "uncertain");
    assert.deepEqual(await controlledWorkspaceEvent, { kind: "workspace.incremented", count: 6 });
    await assertNoSocketMessage(otherObservation.socket);
    const beforeAlarm = await json(first, `/control/status/${proposal.id}`);
    assert.ok(beforeAlarm.attempt);
    assert.equal(beforeAlarm.receipt, undefined);

    // Do not call alarm() ourselves: wait for Miniflare/workerd to deliver the
    // stored alarm. Delivery is at-least-once, so repeat delivery must classify
    // the same durable evidence without applying the increment again.
    const afterAlarm = await waitForReceipt(first, proposal.id);
    assert.deepEqual(afterAlarm.receipt.output, { count: 6 });
    const deliveries = await waitForAlarmDeliveries(first, beforeAlarm.attempt.id, 2);
    assert.equal(deliveries.filter((receipt) => receipt.attemptId === beforeAlarm.attempt.id).length, 2);
    const afterRepeatedAlarm = await json(first, `/control/status/${proposal.id}`);
    assert.deepEqual(afterRepeatedAlarm.receipt.output, { count: 6 });
    const count = await json(first, "/boundary/invoke", await readFrom(manifest));
    assert.deepEqual(count.result.value, { count: 6 });
  } finally {
    await first.dispose();
  }

  const reconstructed = miniflare(worker, "deployment-one");
  try {
    assert.equal(await json(reconstructed, "/attach", undefined), "reconstructed");
    const replay = await json(reconstructed, "/boundary/invoke", originalInvocation);
    assert.equal(replay.result.kind, "proposed");
    const manifest = await (await request(reconstructed, "/boundary/manifest")).json();
    const read = await json(reconstructed, "/boundary/invoke", await readFrom(manifest));
    assert.deepEqual(read.result.value, { count: 6 });
  } finally {
    await reconstructed.dispose();
  }

  const replacement = miniflare(worker, "deployment-two");
  try {
    assert.equal(await json(replacement, "/attach", undefined), "replaced");
    const stale = await request(replacement, "/boundary/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalInvocation),
    });
    assert.equal(stale.status, 409);
    await stale.text();
  } finally {
    await replacement.dispose();
  }
  console.log("Durable Object selected-interaction smoke passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
