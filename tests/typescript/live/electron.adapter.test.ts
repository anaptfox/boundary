import { describe, expect, it, vi } from "vitest";
import {
  createElectronIpcFetch,
  createSurfaceElectronMain,
} from "@foxworth/boundary/electron";
import {
  fakeElectron,
  TEST_CHANNEL,
  TEST_DOORS,
  TEST_PROTOCOL_URL,
  TEST_SCHEME,
} from "../helpers/electron";

// Real TCP and fetch; protocol and IPC use injected Electron APIs.
describe("Electron localhost transport", () => {
  it("dispatches HTTP, protocol, and IPC through the same handler", async () => {
    const fake = fakeElectron();
    const handler = vi.fn(async (request: Request) => {
      const body = request.method === "POST" ? await request.text() : "";
      return new Response(`${request.method}:${new URL(request.url).pathname}:${body}`, {
        headers: { "x-door": "ok" },
      });
    });
    const main = await createSurfaceElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler,
      ipc: fake.ipcPolicy,
      port: 0,
      openWindow: false,
    });
    try {
      const http = await fetch(`${main.baseUrl}/todos`, {
        method: "POST",
        body: "http",
      });
      expect(http.status).toBe(200);
      expect(await http.text()).toBe("POST:/todos:http");

      const protocol = fake.protocolHandlers.get(TEST_SCHEME);
      expect(protocol).toBeTypeOf("function");
      const protocolResponse = await protocol!(
        new Request(`${TEST_PROTOCOL_URL}/_boundary/manifest`),
      );
      expect(await protocolResponse.text()).toBe("GET:/_boundary/manifest:");

      const ipcFetch = createElectronIpcFetch(
        (channel, payload) => fake.invoke(channel, payload),
        { channel: TEST_CHANNEL, baseUrl: TEST_PROTOCOL_URL },
      );
      const ipcResponse = await ipcFetch("/_boundary/invoke", {
        method: "POST",
        body: "ipc",
      });
      expect(await ipcResponse.text()).toBe("POST:/_boundary/invoke:ipc");
      expect(main.protocolUrl).toBe(TEST_PROTOCOL_URL);
    } finally {
      await main.close();
    }
    expect(fake.protocolHandlers.size).toBe(0);
    expect(fake.ipcChannels.size).toBe(0);
  });

  it("does not expose thrown handler errors over HTTP", async () => {
    const fake = fakeElectron();
    const main = await createSurfaceElectronMain({
      ...TEST_DOORS,
      electron: fake.electron,
      handler: async () => {
        throw new Error("postgres://admin:password@internal.example");
      },
      port: 0,
      openWindow: false,
    });
    try {
      const http = await fetch(`${main.baseUrl}/secret`);
      expect(http.status).toBe(500);
      expect(await http.text()).toBe("Internal Server Error");
    } finally {
      await main.close();
    }
  });
});
