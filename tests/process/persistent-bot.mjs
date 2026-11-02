// Test: persistent-bot lifecycle over a real Bun process.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "boundary-persistent-bot-"));
const children = [];

async function until(check, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

async function start(name, mode = "normal", cli = false) {
  const database = join(directory, `${name}.sqlite`);
  const args = mode === "main"
    ? ["examples/apps/typescript/persistent-bot/src/main.ts", "--db", database, "--port", "0"]
    : ["examples/apps/typescript/persistent-bot/test-host.ts", database, mode, cli ? "allow-cli" : ""];
  const child = spawn("bun", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const processState = { child, messages: [], output: "", result: undefined };
  children.push(processState);
  child.stdout.on("data", chunk => {
    processState.output += String(chunk);
    if (mode === "main") {
      const address = /persistent-bot listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(processState.output)?.[1];
      if (address) processState.messages.push({ type: "ready", origin: address });
    }
  });
  child.stderr.on("data", chunk => { processState.output += String(chunk); });
  child.on("message", message => processState.messages.push(message));
  child.on("error", error => { processState.result = { error }; });
  child.on("exit", (code, signal) => { processState.result = { code, signal }; });
  const ready = await until(() => {
    if (processState.result) throw new Error(`Bun startup failed: ${processState.output}`);
    return processState.messages.find(message => message.type === "ready");
  }, "Bun host readiness");
  return { ...processState, state: processState, origin: ready.origin };
}

async function stop(host) {
  if (!host.state.result) host.child.kill("SIGTERM");
  const result = await until(() => host.state.result, "host-owned cleanup");
  assert.equal(result.code, 0, host.state.output);
}

function http(host, path = "/", { method = "GET", body = "", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let result;
    const req = request(new URL(path, host.origin), {
      method,
      agent: false,
      headers: { connection: "close", ...headers },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => { result = { status: response.statusCode, headers: response.headers, text }; });
    });
    req.on("socket", socket => socket.on("close", () => {
      if (result) resolve(result);
      else reject(new Error("The host closed before completing its response"));
    }));
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP request did not finish independently")));
    req.end(body);
  });
}

async function snapshot(host) {
  const response = await http(host, "/api/snapshot");
  assert.equal(response.status, 200, response.text);
  return JSON.parse(response.text);
}

const formBody = (goal, requestId = randomUUID()) => new URLSearchParams({ goal, requestId }).toString();
function post(host, path, body = "", headers = {}) {
  return http(host, path, {
    method: "POST",
    body,
    headers: { origin: host.origin, "content-type": "application/x-www-form-urlencoded", ...headers },
  });
}
async function boundary(host) {
  await until(() => host.state.messages.some(message => message.type === "boundary"), "host effect barrier");
}
async function completed(host) {
  return until(async () => {
    const state = await snapshot(host);
    return state.tasks[0]?.state === "review" ? state : undefined;
  }, "persisted review after client disconnected");
}

try {
  const main = await start("human-main", "main");
  const humanPage = await http(main);
  const humanRequestId = /name="requestId" value="([^"]+)"/.exec(humanPage.text)?.[1];
  assert.ok(humanRequestId);
  assert.equal((await post(main, "/delegate", formBody("From the real human form", humanRequestId))).status, 303);
  assert.equal((await completed(main)).applicationTasks[0].title, "From the real human form");
  await stop(main);

  const background = await start("background", "before");
  const page = await http(background);
  assert.match(page.text, /Delegate one bounded job/);
  const formId = /name="requestId" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(formId, "The human form must carry a durable submission key");
  const submission = formBody("Draft after the page closes", formId);
  const accepted = await post(background, "/delegate", submission, { "sec-fetch-site": "same-origin" });
  assert.equal(accepted.status, 303, accepted.text);
  // http() resolves only after the response has ended AND the client socket closed.
  // The worker remains blocked, so acceptance cannot have waited for completion.
  await boundary(background);
  assert.equal((await snapshot(background)).applicationTasks.length, 0);
  background.child.send("release");
  const reviewed = await completed(background);
  assert.equal(reviewed.applicationTasks.length, 1);
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(reviewed.conversations.length, 1);
  assert.equal((await post(background, "/delegate", submission)).status, 303);
  assert.deepEqual(await snapshot(background), reviewed, "Duplicate submission must not replay work");
  const afterCompleted = await post(background, `/tasks/${reviewed.tasks[0].id}/interrupt`);
  assert.match(afterCompleted.headers.location, /notice=unchanged/);
  assert.deepEqual(await snapshot(background), reviewed, "Completed work must not get false stopped progress");
  await stop(background);
  const reconnected = await start("background");
  assert.deepEqual(await snapshot(reconnected), reviewed, "Reconnect/restart must restore saved review");
  await stop(reconnected);

  const interrupted = await start("interrupted", "before");
  assert.equal((await post(interrupted, "/delegate", formBody("Cancel before writing"))).status, 303);
  await boundary(interrupted);
  const running = (await snapshot(interrupted)).tasks[0];
  const stopped = await post(interrupted, `/tasks/${running.id}/interrupt`);
  assert.match(stopped.headers.location, /notice=interrupted/);
  await stop(interrupted);
  const interruptedRestart = await start("interrupted");
  const cancelled = await snapshot(interruptedRestart);
  assert.equal(cancelled.tasks[0].state, "interrupted");
  assert.equal(cancelled.tasks[0].effectState, null);
  assert.equal(cancelled.applicationTasks.length, 0);
  assert.equal(cancelled.reviews.length, 0);
  await stop(interruptedRestart);

  const settling = await start("settling", "after");
  await post(settling, "/delegate", formBody("Already started"));
  await boundary(settling);
  const effectJob = (await snapshot(settling)).tasks[0];
  assert.match((await post(settling, `/tasks/${effectJob.id}/interrupt`)).headers.location, /notice=settling/);
  assert.match((await post(settling, `/tasks/${effectJob.id}/reconcile`)).headers.location, /notice=settling/);
  settling.child.send("release");
  assert.equal((await completed(settling)).applicationTasks.length, 1);
  await stop(settling);

  for (const [mode, expected, drafts] of [["throw-before", "failed", 0], ["throw-after", "uncertain", 1]]) {
    const failed = await start(mode, mode);
    await post(failed, "/delegate", formBody(mode));
    const state = await until(async () => {
      const value = await snapshot(failed);
      return value.tasks[0]?.state === expected ? value : undefined;
    }, `immediate ${expected} status without restart`);
    assert.equal(state.applicationTasks.length, drafts);
    if (expected === "uncertain") {
      await post(failed, `/tasks/${state.tasks[0].id}/reconcile`);
      assert.equal((await completed(failed)).applicationTasks.length, 1);
    }
    await stop(failed);
  }

  const crashed = await start("crash", "crash");
  assert.equal((await post(crashed, "/delegate", formBody("Crash-window draft"))).status, 303);
  const exit = await until(() => crashed.state.result, "SIGKILL after committed effect");
  assert.equal(exit.signal, "SIGKILL", crashed.state.output);
  const restarted = await start("crash");
  const uncertain = await snapshot(restarted);
  assert.equal(uncertain.tasks[0].state, "uncertain");
  assert.equal(uncertain.tasks[0].effectState, "uncertain");
  assert.equal(uncertain.applicationTasks.length, 1);
  const reconcilePath = `/tasks/${uncertain.tasks[0].id}/reconcile`;
  await post(restarted, reconcilePath);
  const reconciled = await completed(restarted);
  assert.equal(reconciled.tasks[0].effectState, "completed");
  assert.equal(reconciled.applicationTasks.length, 1);
  assert.equal(reconciled.reviews.length, 1);
  await post(restarted, reconcilePath);
  assert.deepEqual(await snapshot(restarted), reconciled);
  await stop(restarted);

  const secure = await start("http-security");
  const initial = await snapshot(secure);
  for (const headers of [
    { origin: "https://attacker.invalid" },
    { origin: "null" },
    { host: "rebound.attacker.invalid", origin: "http://rebound.attacker.invalid" },
    { host: "rebound.attacker.invalid" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    assert.equal((await post(secure, "/delegate", formBody("Forbidden mutation"), headers)).status, 403);
  }
  const noOrigin = await http(secure, "/delegate", {
    method: "POST", body: formBody("Missing Origin"),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await http(secure, "/api/snapshot", { headers: { host: "rebound.attacker.invalid" } })).status, 403);
  assert.deepEqual(await snapshot(secure), initial, "Rejection must happen before acceptance/effects");
  await stop(secure);

  const cli = await start("cli", "normal", true);
  assert.equal((await http(cli, "/delegate", {
    method: "POST", body: formBody("Explicit native CLI delegation"),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })).status, 303);
  assert.equal((await post(cli, "/delegate", formBody("Cross-site still blocked"), { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await completed(cli)).applicationTasks.length, 1);
  await stop(cli);

  console.log("persistent bot background/disconnect/interruption/failure/HTTP proof passed");
  console.log("persistent bot subprocess crash/restart/reconciliation proof passed");
} finally {
  // Kill and await only the exact subprocesses this harness started, even on assertion failure.
  for (const state of children) {
    if (!state.result) state.child.kill("SIGKILL");
  }
  await Promise.all(children.map(state => until(() => state.result, "fixture process cleanup")));
  await rm(directory, { recursive: true, force: true });
}
