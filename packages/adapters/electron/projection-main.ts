import { createServer, type Server } from "node:http";
import type { HttpHandler } from "@foxworth/boundary/http";
import {
  sendFetchResponse,
  toFetchRequest,
} from "@foxworth/boundary/http/node";
import type {
  App as ElectronApp,
  BrowserWindow as ElectronBrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  Protocol,
  Session,
} from "electron";
import { dispatchHandler } from "./dispatch";
import {
  installElectronIpcBridge,
  type ElectronIpcBridgeOptions,
} from "./ipc";

type ElectronSessionApi = {
  fromPartition(partition: string): Session;
};

const preparedSchemes = new WeakMap<Protocol, Set<string>>();
const RESERVED_SCHEMES = new Set([
  "about",
  "blob",
  "data",
  "electron",
  "file",
  "http",
  "https",
  "javascript",
]);

/** Injected from the Electron entry; this package never discovers the app. */
export type ElectronApis = {
  app: ElectronApp;
  BrowserWindow: typeof ElectronBrowserWindow;
  ipcMain?: IpcMain;
  protocol?: Protocol;
  session?: ElectronSessionApi;
};

export type SurfaceElectronReadyContext = {
  readonly baseUrl: string;
  readonly protocolUrl: string;
  readonly window: ElectronBrowserWindow | undefined;
  dispatch(request: Request): Promise<Response>;
};

export type CreateSurfaceElectronMainOptions<Context = never> = {
  readonly electron: ElectronApis;
  /** The HTTP projection created by `createHttpHandler`. */
  readonly handler: HttpHandler;
  /**
   * Host-owned localhost TCP port for the HTTP door.
   * `false` skips TCP; the renderer can still use protocol or IPC.
   */
  readonly port: number | false;
  readonly rendererUrl?: string;
  readonly windowOptions?: BrowserWindowConstructorOptions;
  /** When false, start only the projection doors. Default true. */
  readonly openWindow?: boolean;
  /**
   * Host-owned privileged in-process scheme.
   * `false` skips `protocol.handle`.
   */
  readonly scheme: string | false;
  /**
   * Host-owned IPC channel prefix for `channel:fetch`.
   * `false` skips the IPC door.
   */
  readonly ipcChannel: string | false;
  /**
   * Explicit renderer trust and context policy for the IPC door. An omitted
   * policy fails closed; renderer headers are never treated as identity.
   */
  readonly ipc?: ElectronIpcBridgeOptions<Context>;
  /** Session partition for the window and protocol door. */
  readonly partition: string;
  /**
   * Unique window `name` for Electron 44 `windowStatePersistence`.
   * Persistence is on when this is set, unless `persistWindowState` is false.
   */
  readonly windowName?: string;
  readonly persistWindowState?: boolean;
  readonly onReady?: (
    context: SurfaceElectronReadyContext,
  ) => void | Promise<void>;
};

export type SurfaceElectronMain = {
  readonly baseUrl: string;
  readonly protocolUrl: string;
  readonly window: ElectronBrowserWindow | undefined;
  dispatch(request: Request): Promise<Response>;
  /** Stop HTTP, protocol, and IPC doors without owning Electron's lifecycle. */
  close(): Promise<void>;
};

export type PrepareSurfaceElectronOptions = {
  readonly scheme: string | false;
};

function schemeName(value: string | false): string | undefined {
  if (value === false) return undefined;
  const scheme = value;
  if (
    !/^[a-z][a-z0-9+.-]*$/u.test(scheme) ||
    RESERVED_SCHEMES.has(scheme)
  ) {
    throw new TypeError(
      `@foxworth/boundary/electron: invalid protocol scheme: ${scheme}`,
    );
  }
  return scheme;
}

function protocolUrlFor(scheme: string | undefined): string {
  return scheme ? `${scheme}://projection` : "";
}

/**
 * Register the privileged in-process scheme. Must run before `app.ready`.
 * `createSurfaceElectronMain` calls this when the app is not yet ready.
 */
export function prepareSurfaceElectron(
  electron: Pick<ElectronApis, "app" | "protocol">,
  options: PrepareSurfaceElectronOptions,
): void {
  const scheme = schemeName(options.scheme);
  if (!scheme || !electron.protocol || electron.app.isReady()) return;
  const prepared = preparedSchemes.get(electron.protocol) ?? new Set<string>();
  if (prepared.has(scheme)) return;
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
  prepared.add(scheme);
  preparedSchemes.set(electron.protocol, prepared);
}

function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("@foxworth/boundary/electron: HTTP server has no TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

type Cleanup = () => void | Promise<void>;

async function closeResources(
  cleanups: Cleanup[],
  server: Server | undefined,
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  try {
    await closeServer(server);
  } catch (error) {
    if (!failed) {
      failed = true;
      firstError = error;
    }
  }
  if (failed) throw firstError;
}

function windowOptionsFor<Context>(
  options: CreateSurfaceElectronMainOptions<Context>,
  partition: string,
): BrowserWindowConstructorOptions {
  const persist =
    Boolean(options.windowName) && options.persistWindowState !== false;
  const requested = options.windowOptions ?? {};
  return {
    width: 1100,
    height: 800,
    ...(persist
      ? {
          name: options.windowName,
          windowStatePersistence: true,
        }
      : {}),
    ...requested,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      ...requested.webPreferences,
    },
  };
}

/**
 * Run one explicit surface HTTP handler in Electron's main process.
 * HTTP, a privileged scheme, and IPC are doors to the same handler.
 * Renderer placement and window lifecycle remain application decisions.
 */
export async function createSurfaceElectronMain<Context = never>(
  options: CreateSurfaceElectronMainOptions<Context>,
): Promise<SurfaceElectronMain> {
  const { app: electronApp, BrowserWindow } = options.electron;
  const openWindow = options.openWindow !== false;
  const scheme = schemeName(options.scheme);
  const partition = options.partition;
  if (!partition.trim()) {
    throw new TypeError("@foxworth/boundary/electron: partition must be non-empty");
  }
  const ipcChannel = options.ipcChannel === false ? undefined : options.ipcChannel;
  const protocolUrl = protocolUrlFor(scheme);
  const dispatch = (request: Request) =>
    dispatchHandler(options.handler, request);

  prepareSurfaceElectron(options.electron, { scheme: options.scheme });
  await electronApp.whenReady();

  let server: Server | undefined;
  const cleanups: Cleanup[] = [];
  let baseUrl = protocolUrl;
  let window: ElectronBrowserWindow | undefined;
  try {
    let httpUrl: string | undefined;
    const port = options.port;
    if (port !== false) {
      server = createServer(async (incoming, outgoing) => {
        try {
          const request = toFetchRequest(incoming, {
            origin: `http://${incoming.headers.host ?? "127.0.0.1"}`,
          });
          const response = await dispatch(request);
          await sendFetchResponse(
            outgoing,
            response,
            incoming.method ?? "GET",
          );
        } catch {
          if (!outgoing.headersSent) {
            outgoing.writeHead(500, {
              "content-type": "text/plain; charset=utf-8",
            });
          }
          if (!outgoing.writableEnded) outgoing.end("Internal Server Error");
        }
      });
      httpUrl = await listen(server, port);
    }

    if (ipcChannel && options.electron.ipcMain) {
      const ipcOptions = options.ipc;
      const bridgeOptions = ipcOptions &&
        ipcOptions.ipcHandler !== undefined && ipcOptions.createContext !== undefined
        ? {
            validateSender: ipcOptions.validateSender,
            createContext: ipcOptions.createContext,
            ipcHandler: ipcOptions.ipcHandler,
          }
        : { validateSender: ipcOptions?.validateSender ?? (() => false) };
      cleanups.push(
        installElectronIpcBridge(
          options.electron.ipcMain,
          options.handler,
          ipcChannel,
          bridgeOptions,
        ),
      );
    }

    if (scheme && options.electron.session) {
      const session = options.electron.session.fromPartition(partition);
      session.protocol.handle(scheme, (request: Request) => dispatch(request));
      cleanups.push(() => {
        session.protocol.unhandle(scheme);
      });
    }

    baseUrl = httpUrl ?? protocolUrl;
    if (openWindow) {
      window = new BrowserWindow(windowOptionsFor(options, partition));
    }

    if (options.onReady) {
      await options.onReady({ baseUrl, protocolUrl, window, dispatch });
    } else if (window && options.rendererUrl) {
      await window.loadURL(options.rendererUrl);
    }
  } catch (error) {
    try {
      await closeResources(cleanups, server);
    } catch {
      // Preserve the startup failure; cleanup is best effort on this path.
    }
    throw error;
  }

  return Object.freeze({
    baseUrl,
    protocolUrl,
    window,
    dispatch,
    close: () => closeResources(cleanups, server),
  });
}
