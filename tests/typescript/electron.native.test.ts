import { describe, expect, it } from "vitest";
import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { createHandoffInvocation } from "@foxworth/boundary/handoff";
import {
  allowElectronSender,
  createProjectionElectronMain,
  ipcFetchChannel,
  serializeFetchRequest,
  type ElectronIpcInvokeEvent,
  type ElectronIpcSender,
  type ElectronIpcSenderFrame,
} from "@foxworth/boundary/electron";
import {
  fakeElectron,
  TEST_CHANNEL,
  TEST_DOORS,
  TEST_PROTOCOL_URL,
} from "./helpers/electron";
import { createCaller } from "@foxworth/boundary/pipeline";

const firstWindowFrame = { url: TEST_PROTOCOL_URL, parent: null, isDestroyed: () => false } as unknown as ElectronIpcSenderFrame;
const secondWindowFrame = { url: TEST_PROTOCOL_URL, parent: null, isDestroyed: () => false } as unknown as ElectronIpcSenderFrame;
let firstDestroyed = false;
let liveFirstFrame: ElectronIpcSenderFrame = firstWindowFrame;
const firstWindowWebContents = {
  isDestroyed: () => firstDestroyed,
  get mainFrame() { return liveFirstFrame; },
} as unknown as ElectronIpcSender;
const secondWindowWebContents = {
  isDestroyed: () => false,
  mainFrame: secondWindowFrame,
} as unknown as ElectronIpcSender;
const sender = (
  webContents = firstWindowWebContents,
  frame = firstWindowFrame,
): ElectronIpcInvokeEvent => ({ sender: webContents, senderFrame: frame });

describe("@foxworth/boundary/electron native trust seam", () => {
  it("serves a real bound read/change surface per trusted workspace and scopes observations", async () => {
    type Context = Readonly<{ workspaceId: "alpha" | "beta" }>;
    const Workspace = portableSchema<{ workspaceId: string; count: number }>({
      type: "object",
      properties: { workspaceId: { type: "string" }, count: { type: "integer" } },
      required: ["workspaceId", "count"],
      additionalProperties: false,
    });
    const Amount = portableSchema<{ amount: number }>({
      type: "object",
      properties: { amount: { type: "integer", minimum: 1 } },
      required: ["amount"],
      additionalProperties: false,
    });
    const interactions = {
      read: defineInteraction({ id: "workspace.read", output: Workspace, reads: ["workspace"], changes: [] }),
      increment: defineInteraction({ id: "workspace.increment", input: Amount, output: Workspace, reads: ["workspace"], changes: ["workspace"] }),
    } as const;
    const state = new Map<Context["workspaceId"], number>([["alpha", 0], ["beta", 10]]);
    const compiled = await compileInteractions(interactions);
    const implementations = implementInteractions<typeof interactions, Context>(interactions, {
      read: (context) => ({ workspaceId: context.workspaceId, count: state.get(context.workspaceId)! }),
      increment: (input, context) => {
        const count = state.get(context.workspaceId)! + input.amount;
        state.set(context.workspaceId, count);
        return { workspaceId: context.workspaceId, count };
      },
    });
    const { installation, controller: installationController } = await installInteractions(compiled, {
      installationId: "electron:workspaces:1",
      implementations,
      realizationIds: { read: { direct: "workspace:read:1" }, increment: { direct: "workspace:increment:1" } },
    });
    const projection = await projectInteractions(compiled, {
      read: { interaction: compiled.handles.read, modes: ["direct"] },
      increment: { interaction: compiled.handles.increment, modes: ["direct"] },
    });
    const delivered = new Map<Context["workspaceId"], unknown[]>();
    const subscribers = new Map<Context["workspaceId"], Set<(value: unknown) => void>>([
      ["alpha", new Set()], ["beta", new Set()],
    ]);
    const bound = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
      observation: {
        correlate: (context) => ({ workspaceId: context.workspaceId }),
        publish: (event) => {
          const workspaceId = (event.correlation as { workspaceId?: Context["workspaceId"] } | undefined)?.workspaceId;
          if (!workspaceId) return;
          for (const deliver of subscribers.get(workspaceId) ?? []) deliver(event);
        },
      },
    });
    if (bound.status !== "bound") throw new Error("workspace projection did not bind");
    for (const workspaceId of ["alpha", "beta"] as const) {
      delivered.set(workspaceId, []);
      subscribers.get(workspaceId)!.add((event) => delivered.get(workspaceId)!.push(event));
    }
    const handler = createProtocolHandler<Context>({
      caller: createCaller(bound.binding),
      path: "/_boundary",
      context: (request) => ({ workspaceId: request.headers.get("x-host-workspace") as Context["workspaceId"] }),
    });
    const fake = fakeElectron();
    const frames = new Map([
      ["alpha", { url: TEST_PROTOCOL_URL, parent: null, isDestroyed: () => false } as unknown as ElectronIpcSenderFrame],
      ["beta", { url: TEST_PROTOCOL_URL, parent: null, isDestroyed: () => false } as unknown as ElectronIpcSenderFrame],
    ]);
    const webContents = new Map([...frames.keys()].map((workspaceId) => [workspaceId, {
      isDestroyed: () => false,
      mainFrame: frames.get(workspaceId),
    } as unknown as ElectronIpcSender]));
    const active = new Map<Context["workspaceId"], boolean>([["alpha", true], ["beta", true]]);
    const main = await createProjectionElectronMain<Context>({
      ...TEST_DOORS, electron: fake.electron, handler, port: false, openWindow: false,
      ipc: {
        validateSender: (event) => [...webContents.entries()].some(([workspaceId, sender]) => active.get(workspaceId as Context["workspaceId"]) && allowElectronSender({ sender, frame: frames.get(workspaceId)!, url: TEST_PROTOCOL_URL })(event)),
        createContext: (event) => {
          const workspaceId = [...webContents.entries()].find(([, sender]) => sender === event.sender)?.[0];
          if (workspaceId !== "alpha" && workspaceId !== "beta") throw new Error("unknown workspace");
          return { workspaceId };
        },
        ipcHandler: (request, context) => {
          const headers = new Headers(request.headers);
          headers.set("x-host-workspace", context.workspaceId);
          return handler(new Request(request, { headers }));
        },
      },
    });
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- body is only passed with non-GET methods
    const payload = async (url: string, method = "GET", body?: string) => serializeFetchRequest(new Request(`${TEST_PROTOCOL_URL}${url}`, { method, body, headers: body ? { "content-type": "application/json" } : undefined }));
    const call = async (workspaceId: Context["workspaceId"], url: string, method = "GET", body?: string) => {
      const listener = fake.ipcChannels.get(ipcFetchChannel(TEST_CHANNEL))!;
      return listener({ sender: webContents.get(workspaceId)!, senderFrame: frames.get(workspaceId)! }, await payload(url, method, body));
    };
    const alphaRead = await call("alpha", "/_boundary/manifest");
    expect(alphaRead.status).toBe(200);
    const alphaInvocation = await createHandoffInvocation(bound.binding.manifest, "workspace.increment", "direct", { amount: 2 });
    const alphaChange = await call("alpha", "/_boundary/invoke", "POST", JSON.stringify(alphaInvocation));
    expect(alphaChange.status).toBe(200);
    expect(state.get("alpha")).toBe(2);
    expect(state.get("beta")).toBe(10);
    expect(delivered.get("alpha")).toHaveLength(1);
    expect(delivered.get("beta")).toHaveLength(0);
    active.set("alpha", false);
    await expect(call("alpha", "/_boundary/manifest")).resolves.toMatchObject({ status: 403 });
    active.set("alpha", true);
    (frames.get("alpha") as { url: string }).url = "my-app-boundary://logout";
    await expect(call("alpha", "/_boundary/manifest")).resolves.toMatchObject({ status: 403 });
    subscribers.get("alpha")!.clear();
    subscribers.get("beta")!.clear();
    installationController.revoke();
    const betaInvocation = await createHandoffInvocation(bound.binding.manifest, "workspace.increment", "direct", { amount: 1 });
    await expect(call("beta", "/_boundary/invoke", "POST", JSON.stringify(betaInvocation))).resolves.toMatchObject({ status: 409 });
    await main.close();
    expect(fake.ipcChannels.size).toBe(0);
    expect(delivered.get("beta")).toHaveLength(0);
  });

  it("validates the frame before context creation or handler dispatch", async () => {
    const fake = fakeElectron();
    const contexts: unknown[] = [];
    let calls = 0;
    let revoked = false;
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => new Response("trusted"),
      ipc: {
        ipcHandler: async (_request: Request, context: { frameUrl?: string }) => {
        calls += 1;
        contexts.push(context);
        if (revoked) return new Response("revoked", { status: 409 });
        return new Response("trusted");
        },
        validateSender: allowElectronSender({
          sender: firstWindowWebContents,
          frame: firstWindowFrame,
          url: TEST_PROTOCOL_URL,
        }),
        createContext: (event) => ({ frameUrl: event.senderFrame?.url }),
      },
      port: false,
      openWindow: false,
    });

    const listener = fake.ipcChannels.get(ipcFetchChannel(TEST_CHANNEL))!;
    const payload = {
      url: `${TEST_PROTOCOL_URL}/health`,
      method: "GET",
      headers: [],
      body: null,
    } as const;
    await expect(listener(sender(), payload)).resolves.toMatchObject({
      status: 200,
      body: "trusted",
    });
    await expect(
      listener(sender(secondWindowWebContents, secondWindowFrame), payload),
    ).resolves.toMatchObject({ status: 403, body: "Forbidden" });

    (firstWindowFrame as unknown as { url: string }).url = "my-app-boundary://navigated";
    await expect(listener(sender(), payload)).resolves.toMatchObject({ status: 403, body: "Forbidden" });
    (firstWindowFrame as unknown as { url: string }).url = TEST_PROTOCOL_URL;
    const mutablePolicy = {
      sender: firstWindowWebContents,
      frame: firstWindowFrame,
      url: TEST_PROTOCOL_URL,
    };
    const snapshotValidator = allowElectronSender(mutablePolicy);
    mutablePolicy.sender = secondWindowWebContents;
    expect(snapshotValidator(sender())).toBe(true);
    firstDestroyed = true;
    await expect(listener(sender(), payload)).resolves.toMatchObject({ status: 403, body: "Forbidden" });
    firstDestroyed = false;
    revoked = true;
    await expect(listener(sender(), payload)).resolves.toMatchObject({
      status: 409,
      body: "revoked",
    });

    expect(calls).toBe(2);
    expect(contexts).toEqual([
      { frameUrl: TEST_PROTOCOL_URL },
      { frameUrl: TEST_PROTOCOL_URL },
    ]);
    await main.close();
    expect(fake.ipcChannels.size).toBe(0);
  });

  it("closes the IPC door without creating an HTTP server or window", async () => {
    const fake = fakeElectron();
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => new Response("ok"),
      ipc: {
        validateSender: allowElectronSender({
          sender: firstWindowWebContents,
          frame: firstWindowFrame,
          url: TEST_PROTOCOL_URL,
        }),
      },
      port: false,
      openWindow: false,
    });

    expect(main.window).toBeUndefined();
    expect(fake.windows).toHaveLength(0);
    expect(fake.ipcChannels.size).toBe(1);
    await main.close();
    expect(fake.ipcChannels.size).toBe(0);
    await expect(
      main.close(),
    ).resolves.toBeUndefined();
  });

  it("revalidates after asynchronous context creation", async () => {
    const fake = fakeElectron();
    let calls = 0;
    liveFirstFrame = firstWindowFrame;
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => new Response("unused"),
      ipc: {
        validateSender: allowElectronSender({
          sender: firstWindowWebContents,
          frame: firstWindowFrame,
          url: TEST_PROTOCOL_URL,
        }),
        createContext: async () => {
          await Promise.resolve();
          liveFirstFrame = secondWindowFrame;
          return { ok: true };
        },
        ipcHandler: async () => {
          calls += 1;
          return new Response("unexpected");
        },
      },
      port: false,
      openWindow: false,
    });
    const listener = fake.ipcChannels.get(ipcFetchChannel(TEST_CHANNEL))!;
    await expect(listener(sender(), {
      url: `${TEST_PROTOCOL_URL}/health`, method: "GET", headers: [], body: null,
    })).resolves.toMatchObject({ status: 403, body: "Forbidden" });
    expect(calls).toBe(0);
    liveFirstFrame = firstWindowFrame;
    await main.close();
  });
});
