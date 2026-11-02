import { describe, expect, it, vi } from "vitest";
import {
  createElectronIpcFetch,
  createProjectionElectronMain,
  deserializeFetchRequest,
  electronIpcTransport,
  ipcFetchChannel,
  prepareProjectionElectron,
  projectionRequest,
  serializeFetchRequest,
  type SerializedFetchRequest,
} from "@foxworth/boundary/electron";

import {
  fakeElectron,
  TEST_CHANNEL,
  TEST_DOORS,
  TEST_PARTITION,
  TEST_PROTOCOL_URL,
  TEST_SCHEME,
} from "./helpers/electron";

describe("@foxworth/boundary/electron", () => {
  it("can skip TCP and still expose protocol and IPC doors", async () => {
    const fake = fakeElectron();
    const handler = vi.fn(async () => new Response("ok"));
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler,
      ipc: fake.ipcPolicy,
      port: false,
      openWindow: false,
    });

    expect(main.baseUrl).toBe(TEST_PROTOCOL_URL);
    expect(fake.protocolHandlers.has(TEST_SCHEME)).toBe(true);
    expect(
      await fake.invoke(ipcFetchChannel(TEST_CHANNEL), {
        url: `${TEST_PROTOCOL_URL}/health`,
        method: "GET",
        headers: [],
        body: null,
      }),
    ).toMatchObject({ status: 200, body: "ok" });
    await expect(
      fake.invoke(ipcFetchChannel(TEST_CHANNEL), {
        url: `${TEST_PROTOCOL_URL}/health`,
        method: "GET",
        headers: [],
        body: null,
      }, fakeElectron().event),
    ).resolves.toMatchObject({ status: 403, body: "Forbidden" });
    expect(handler).toHaveBeenCalledTimes(1);
    await main.close();
  });

  it("does not expose thrown handler errors on protocol or IPC", async () => {
    const fake = fakeElectron();
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => {
        throw new Error("postgres://admin:password@internal.example");
      },
      ipc: fake.ipcPolicy,
      port: false,
      openWindow: false,
    });

    const protocol = await fake.protocolHandlers.get(TEST_SCHEME)!(
      new Request(`${TEST_PROTOCOL_URL}/secret`),
    );
    expect(protocol.status).toBe(500);
    expect(await protocol.text()).toBe("Internal Server Error");

    const ipc = await fake.invoke(ipcFetchChannel(TEST_CHANNEL), {
      url: `${TEST_PROTOCOL_URL}/secret`,
      method: "GET",
      headers: [],
      body: null,
    });
    expect(ipc.status).toBe(500);
    expect(ipc.body).toBe("Internal Server Error");
    await main.close();
  });

  it("supports bodyless responses and rejects malformed IPC envelopes safely", async () => {
    const fake = fakeElectron();
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => new Response(null, { status: 204 }),
      ipc: fake.ipcPolicy,
      port: false,
      openWindow: false,
    });
    const ipcFetch = createElectronIpcFetch(
      (channel, payload) => fake.invoke(channel, payload),
      { channel: TEST_CHANNEL, baseUrl: TEST_PROTOCOL_URL },
    );

    const empty = await ipcFetch("/empty");
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const malformed = await fake.invoke(
      ipcFetchChannel(TEST_CHANNEL),
      undefined as unknown as SerializedFetchRequest,
    );
    expect(malformed).toMatchObject({
      status: 500,
      body: "Internal Server Error",
    });
    await main.close();
  });

  it("unwinds installed doors when startup fails", async () => {
    const fake = fakeElectron({
      protocolHandleError: new Error("protocol registration failed"),
    });

    await expect(
      createProjectionElectronMain({
        ...TEST_DOORS,
        electron: fake.electron,
        handler: async () => new Response("ok"),
        ipc: fake.ipcPolicy,
        port: false,
        openWindow: false,
      }),
    ).rejects.toThrow("protocol registration failed");
    expect(fake.ipcChannels.size).toBe(0);
    expect(fake.protocolHandlers.size).toBe(0);
  });

  it("restores window bounds through Electron 44 window state when named", async () => {
    const fake = fakeElectron();
    const main = await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => new Response("ok"),
      ipc: fake.ipcPolicy,
      port: false,
      windowName: "study",
      windowOptions: { width: 640, height: 480 },
      onReady: async () => undefined,
    });

    expect(fake.windows).toEqual([
      expect.objectContaining({
        name: "study",
        windowStatePersistence: true,
        width: 640,
        height: 480,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: TEST_PARTITION,
        }),
      }),
    ]);
    await main.close();
  });

  it("registers a privileged scheme only before app ready", () => {
    const before = fakeElectron({ ready: false });
    prepareProjectionElectron(before.electron, { scheme: TEST_SCHEME });
    prepareProjectionElectron(before.electron, { scheme: TEST_SCHEME });
    expect(before.schemes).toEqual([
      expect.objectContaining({
        scheme: TEST_SCHEME,
        privileges: expect.objectContaining({
          standard: true,
          secure: true,
          supportFetchAPI: true,
        }),
      }),
    ]);

    const after = fakeElectron({ ready: true });
    prepareProjectionElectron(after.electron, { scheme: TEST_SCHEME });
    expect(after.schemes).toEqual([]);
  });

  it("rejects reserved protocol schemes", async () => {
    const fake = fakeElectron();
    await expect(
      createProjectionElectronMain({
        ...TEST_DOORS,
        electron: fake.electron,
        handler: async () => new Response("ok"),
        ipc: fake.ipcPolicy,
        scheme: "https",
        port: false,
        openWindow: false,
      }),
    ).rejects.toThrow(/invalid protocol scheme/);
  });

  it("round-trips a serialized request for the IPC door", async () => {
    const request = new Request(`${TEST_PROTOCOL_URL}/_boundary/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": "owner" },
      body: "{\"ok\":true}",
    });
    const wire = await serializeFetchRequest(request);
    const restored = deserializeFetchRequest(wire);
    expect(restored.url).toBe(request.url);
    expect(restored.method).toBe("POST");
    expect(restored.headers.get("x-test-actor")).toBe("owner");
    expect(await restored.text()).toBe("{\"ok\":true}");

    const overridden = projectionRequest(
      new Request(`${TEST_PROTOCOL_URL}/original`),
      TEST_PROTOCOL_URL,
      { method: "POST", body: "override" },
    );
    expect(overridden.method).toBe("POST");
    expect(await overridden.text()).toBe("override");
  });

  it("builds a protocol client transport over IPC", async () => {
    const fake = fakeElectron();
    await createProjectionElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async (request) => {
        if (new URL(request.url).pathname.endsWith("/manifest")) {
          return Response.json({
            version: 1,
            bindingDigest: "sha256:" + "a".repeat(64),
          });
        }
        return Response.json({ ok: false });
      },
      ipc: fake.ipcPolicy,
      port: false,
      openWindow: false,
    });

    const transport = electronIpcTransport({
      invoke: (channel, payload) => fake.invoke(channel, payload),
      channel: TEST_CHANNEL,
      baseUrl: `${TEST_PROTOCOL_URL}/_boundary`,
    });
    const handshake = await transport.inspect();
    expect(handshake).toMatchObject({
      version: 1,
      bindingDigest: "sha256:" + "a".repeat(64),
    });
  });
});
