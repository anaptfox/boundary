import { publishedAliases } from "../../../../scripts/build/published-aliases.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules, createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const requireFromElectronPackage = createRequire(join(root, "packages/package.json"));
const electronBin = process.env.ELECTRON_BIN ?? requireFromElectronPackage("electron");
const directory = await mkdtemp(join(tmpdir(), "boundary-electron-native-"));
const entry = join(directory, "entry.ts");
const preload = join(directory, "preload.cjs");
const page = join(directory, "index.html");

try {
  await writeFile(preload, `const { contextBridge, ipcRenderer } = require("electron");
  contextBridge.exposeInMainWorld("opsProof", { invoke(value) { return ipcRenderer.invoke("my-app-boundary:fetch", value); } });
`);
  await writeFile(page, "<!doctype html><title>boundary-electron-proof</title>");
  await writeFile(entry, `import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { createHandoffInvocation } from "@foxworth/boundary/handoff";
import { prepareSurfaceElectron } from "@foxworth/boundary/electron";
import { installTrustedProjection } from ${JSON.stringify(resolve(root, "tests/fixtures/runtimes/electron/trusted-ipc.ts"))};
prepareSurfaceElectron({ app, protocol }, { scheme: "my-app-boundary" });
app.whenReady().then(async () => {
  const options = { show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: ${JSON.stringify(preload)} } };
  const first = new BrowserWindow(options); const second = new BrowserWindow(options); const third = new BrowserWindow(options);
  await Promise.all([first.loadFile(${JSON.stringify(page)}), second.loadFile(${JSON.stringify(page)}), third.loadFile(${JSON.stringify(page)})]);
  const observations = [];
  const projection = await installTrustedProjection({
    electron: { app, BrowserWindow, ipcMain, protocol, session },
    trustedWindows: {
      alpha: { sender: first.webContents, frame: first.webContents.mainFrame },
      beta: { sender: second.webContents, frame: second.webContents.mainFrame },
    },
    onObservation: (workspaceId) => observations.push(workspaceId),
  });
  const alphaInvocation = await createHandoffInvocation(projection.binding.manifest, "workspace.increment", "direct", { amount: 2 });
  const betaInvocation = await createHandoffInvocation(projection.binding.manifest, "workspace.increment", "direct", { amount: 1 });
  const alphaRead = await createHandoffInvocation(projection.binding.manifest, "workspace.read", "direct", null);
  const betaRead = alphaRead;
  const payload = (invocation) => ({ url: "my-app-boundary://projection/_boundary/invoke", method: "POST", headers: [["content-type", "application/json"]], body: JSON.stringify(invocation) });
  const one = await first.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(alphaInvocation)) + ")");
  const two = await second.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(betaInvocation)) + ")");
  const forged = await first.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify({ ...payload(alphaInvocation), headers: [["content-type", "application/json"], ["x-host-workspace", "beta"]], body: JSON.stringify(await createHandoffInvocation(projection.binding.manifest, "workspace.increment", "direct", { amount: 1 })) }) + ")");
  const alphaAfter = await first.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(alphaRead)) + ")");
  const betaAfter = await second.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(betaRead)) + ")");
  const thirdDenied = await third.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(alphaInvocation)) + ")");
  await first.loadURL("data:text/html,<title>navigated</title>");
  const navigated = await first.webContents.executeJavaScript("window.opsProof.invoke(" + JSON.stringify(payload(alphaInvocation)) + ")");
  projection.revokeWindow(second.webContents);
  second.destroy(); third.destroy();
  const alphaResult = JSON.parse(alphaAfter.body); const betaResult = JSON.parse(betaAfter.body); const forgedResult = JSON.parse(forged.body);
  const noHttpListener = projection.main.baseUrl === projection.main.protocolUrl && !projection.main.baseUrl.startsWith("http");
  if (one.status !== 200 || two.status !== 200 || forgedResult.result?.kind !== "returned" || forgedResult.result.value?.workspaceId !== "alpha" || forgedResult.result.value?.count !== 3 || alphaResult.result?.kind !== "returned" || alphaResult.result.value?.workspaceId !== "alpha" || alphaResult.result.value?.count !== 3 || betaResult.result?.kind !== "returned" || betaResult.result.value?.workspaceId !== "beta" || betaResult.result.value?.count !== 11 || thirdDenied.status !== 403 || navigated.status !== 403 || observations.join(",") !== "alpha,beta,alpha,alpha,beta" || !noHttpListener) {
    console.error("Electron Boundary native assertions failed", { statuses: { one: one.status, two: two.status, forged: forged.status, alphaAfter: alphaAfter.status, betaAfter: betaAfter.status, thirdDenied: thirdDenied.status, navigated: navigated.status }, results: { forged: forgedResult, alphaAfter: alphaResult, betaAfter: betaResult }, observations, noHttpListener });
    process.exitCode = 1;
  }
  else console.log("BOUNDARY_ELECTRON_SMOKE_PASS: returned outcomes, isolated workspaces, forged-header rejection, untrusted same-URL denial, navigation/logout teardown, scoped observations, no HTTP listener");
  await projection.main.close(); first.destroy(); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
`);
  const output = join(directory, "bundle");
  await build({ configFile: false, root, resolve: { alias: publishedAliases(root)  }, build: { lib: { entry, formats: ["cjs"], fileName: () => "main.cjs" }, outDir: output, emptyOutDir: true, rollupOptions: { external: (id) => id === "electron" || id.startsWith("node:") || builtinModules.includes(id) } } });
  const bundle = await readFile(join(output, "main.cjs"), "utf8");
  if (/packages[\\/]\w+[\\/]src[\\/]/u.test(bundle) || bundle.includes("browser-external")) {
    throw new Error("Electron smoke bundle contains a source package path or browser shim");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;
  const child = spawn(electronBin, [join(output, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(value); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    child.once("error", (error) => finish({ code: 127, reason: error }));
    child.once("exit", (code, signal) => finish({ code: timedOut ? 124 : code ?? 128, signal }));
  });
  if (result.code !== 0 || !stdout.includes("BOUNDARY_ELECTRON_SMOKE_PASS")) { console.error(`Electron Boundary smoke failed (${result.code})`, result.reason ?? result.signal ?? "missing success sentinel"); if (stdout) console.error(stdout); if (stderr) console.error(stderr); process.exitCode = result.code || 1; }
  else console.log("Electron Boundary smoke passed: returned outcomes, isolated workspaces, forged-header rejection, untrusted same-URL denial, navigation/logout teardown, scoped observations, no HTTP listener");
} finally {
  await rm(directory, { recursive: true, force: true });
}
