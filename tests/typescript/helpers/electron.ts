import { vi } from "vitest";
import {
  allowElectronSender,
  type ElectronApis,
  type ElectronIpcInvokeEvent,
  type ElectronIpcSender,
  type ElectronIpcSenderFrame,
  type SerializedFetchRequest,
  type SerializedFetchResponse,
} from "@foxworth/boundary/electron";

type ProtocolHandle = (request: Request) => Promise<Response> | Response;

export const TEST_SCHEME = "boundary-test";
export const TEST_CHANNEL = "boundary-test";
export const TEST_PARTITION = "persist:boundary-test";
export const TEST_PROTOCOL_URL = `${TEST_SCHEME}://projection`;
export const TEST_DOORS = Object.freeze({
  scheme: TEST_SCHEME,
  ipcChannel: TEST_CHANNEL,
  partition: TEST_PARTITION,
});

export function fakeElectron(
  options: { ready?: boolean; protocolHandleError?: Error } = {},
) {
  let ready = options.ready ?? true;
  const frame = {
    url: TEST_PROTOCOL_URL,
    parent: null,
    isDestroyed: () => false,
  } as unknown as ElectronIpcSenderFrame;
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
  } as unknown as ElectronIpcSender;
  const event: ElectronIpcInvokeEvent = { sender, senderFrame: frame };
  const ipcPolicy = {
    validateSender: allowElectronSender({ sender, frame, url: TEST_PROTOCOL_URL }),
  };
  const ipc = new Map<
    string,
    (
      event: ElectronIpcInvokeEvent,
      payload: SerializedFetchRequest,
    ) => Promise<SerializedFetchResponse>
  >();
  const schemes: unknown[] = [];
  const protocolHandlers = new Map<string, ProtocolHandle>();
  const windows: Array<Record<string, unknown>> = [];

  class BrowserWindow {
    readonly options: Record<string, unknown>;
    constructor(windowOptions: Record<string, unknown>) {
      this.options = windowOptions;
      windows.push(windowOptions);
    }
    loadURL = vi.fn(async () => undefined);
  }

  const electron = {
    app: {
      isReady: () => ready,
      whenReady: async () => {
        ready = true;
      },
    },
    BrowserWindow,
    ipcMain: {
      handle(
        channel: string,
        listener: (
          event: ElectronIpcInvokeEvent,
          payload: SerializedFetchRequest,
        ) => Promise<SerializedFetchResponse>,
      ) {
        ipc.set(channel, listener);
      },
      removeHandler(channel: string) {
        ipc.delete(channel);
      },
    },
    protocol: {
      registerSchemesAsPrivileged(value: unknown[]) {
        schemes.push(...value);
      },
    },
    session: {
      fromPartition() {
        return {
          protocol: {
            handle(scheme: string, listener: ProtocolHandle) {
              if (options.protocolHandleError) {
                throw options.protocolHandleError;
              }
              protocolHandlers.set(scheme, listener);
            },
            unhandle(scheme: string) {
              protocolHandlers.delete(scheme);
            },
          },
        };
      },
    },
  } as unknown as ElectronApis;

  return {
    electron,
    windows,
    schemes,
    ipcChannels: ipc,
    ipcPolicy,
    event,
    protocolHandlers,
    async invoke(
      channel: string,
      payload: SerializedFetchRequest,
      invocationEvent: ElectronIpcInvokeEvent = event,
    ) {
      const listener = ipc.get(channel);
      if (!listener) throw new Error(`missing ipc handler ${channel}`);
      return listener(invocationEvent, payload);
    },
  };
}
