import type { HttpHandler } from "@foxworth/boundary/http";
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { fetchTransport } from "@foxworth/boundary/http";
import type { ClientTransport } from "@foxworth/boundary/client";
import {
  deserializeFetchRequest,
  deserializeFetchResponse,
  dispatchHandler,
  internalError,
  projectionRequest,
  serializeFetchRequest,
  serializeFetchResponse,
  type SerializedFetchRequest,
  type SerializedFetchResponse,
} from "./dispatch";

export type ElectronIpcInvoke = (
  channel: string,
  payload: SerializedFetchRequest,
) => Promise<SerializedFetchResponse>;

export type ElectronIpcSender = WebContents;
export type ElectronIpcSenderFrame = WebFrameMain;
export type ElectronIpcInvokeEvent = Pick<
  IpcMainInvokeEvent,
  "sender" | "senderFrame"
>;

export type ElectronIpcContextFactory<Context> = (
  event: ElectronIpcInvokeEvent,
) => Context | Promise<Context>;

export type ElectronIpcSenderValidator = (
  event: ElectronIpcInvokeEvent,
) => boolean | Promise<boolean>;

export type ElectronIpcBridgeOptions<Context> =
  | Readonly<{ validateSender: ElectronIpcSenderValidator; createContext: ElectronIpcContextFactory<Context>; ipcHandler: ElectronIpcHandler<Context> }>
  | Readonly<{ validateSender: ElectronIpcSenderValidator; createContext?: never; ipcHandler?: never }>;

export type ElectronIpcHandler<Context = undefined> = (
  request: Request,
  context: Context,
) => Promise<Response>;

export type ElectronIpcHandle = {
  handle(
    channel: string,
    listener: (
      event: ElectronIpcInvokeEvent,
      payload: SerializedFetchRequest,
    ) => Promise<SerializedFetchResponse>,
  ): void;
  removeHandler?(channel: string): void;
};

export function ipcFetchChannel(channel: string): string {
  if (!channel.trim()) {
    throw new TypeError("@foxworth/boundary/electron: IPC channel must be non-empty");
  }
  return `${channel}:fetch`;
}

/** Main-process IPC door: reconstruct a Request and call the same handler. */
export function installElectronIpcBridge<Context = undefined>(
  ipc: ElectronIpcHandle,
  handler: HttpHandler,
  channel: string,
  options: ElectronIpcBridgeOptions<Context>,
): () => void {
  const fetchChannel = ipcFetchChannel(channel);
  ipc.handle(fetchChannel, async (event, payload) => {
    try {
      if (!(await options.validateSender(event))) {
        return await serializeFetchResponse(
          new Response("Forbidden", { status: 403 }),
        );
      }
      const response = await dispatchHandler(
        options.ipcHandler !== undefined && options.createContext !== undefined
          ? async (request) => {
              const context = await options.createContext(event);
              if (!(await options.validateSender(event))) return new Response("Forbidden", { status: 403 });
              return options.ipcHandler(request, context);
            }
          : handler,
        deserializeFetchRequest(payload),
      );
      return await serializeFetchResponse(response);
    } catch {
      return serializeFetchResponse(internalError());
    }
  });
  return () => {
    ipc.removeHandler?.(fetchChannel);
  };
}

/** Validate one exact WebContents and main frame pair; URL alone is insufficient. */
export function allowElectronSender(
  expected: Readonly<{
    sender: ElectronIpcSender;
    frame: ElectronIpcSenderFrame;
    url: string;
  }>,
): ElectronIpcSenderValidator {
  const sender = expected.sender;
  const frame = expected.frame;
  const url = expected.url;
  return (event) =>
    event.sender === sender &&
    event.senderFrame === frame &&
    !sender.isDestroyed() &&
    !frame.isDestroyed() &&
    sender.mainFrame === frame &&
    frame.parent === null &&
    frame.url === url;
}

/**
 * Preload/renderer fetch that posts through `ipcRenderer.invoke`.
 * Relative URLs resolve against the host-owned `baseUrl`.
 */
export function createElectronIpcFetch(
  invoke: ElectronIpcInvoke,
  options: Readonly<{ channel: string; baseUrl: string }>,
): typeof fetch {
  const fetchChannel = ipcFetchChannel(options.channel);
  return async (input, init) => {
    const request = projectionRequest(input, options.baseUrl, init);
    const payload = await serializeFetchRequest(request);
    return deserializeFetchResponse(await invoke(fetchChannel, payload));
  };
}

/** Typed projection client transport over the IPC fetch bridge. */
export function electronIpcTransport(options: {
  readonly invoke: ElectronIpcInvoke;
  readonly channel: string;
  readonly baseUrl: string;
  readonly headers?: HeadersInit;
}): ClientTransport {
  return fetchTransport({
    baseUrl: options.baseUrl,
    fetch: createElectronIpcFetch(options.invoke, {
      channel: options.channel,
      baseUrl: options.baseUrl,
    }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}
