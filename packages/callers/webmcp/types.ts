import type {
  InteractionMode,
  ProjectionBinding,
} from "@foxworth/boundary";
import type { ClientInvokeFraming, ClientTransport } from "@foxworth/boundary/client";
import type { AnyProjectedInteractionHandle } from "@foxworth/boundary/remote";

export type WebMcpTool<
  Handle extends AnyProjectedInteractionHandle = AnyProjectedInteractionHandle,
> = Readonly<{
  handle: Handle;
  mode: InteractionMode;
  name?: string;
  title?: string;
  description?: string;
  /** Browser-facing consequence metadata; never grants authority or selects an execution mode. */
  consequentialHint?: boolean;
  /** Marks a host-selected tool as intended for developer tooling. */
  debugging?: boolean;
  untrustedContentHint?: boolean;
  /** Origins that may discover this tool in the document tree. Same-origin callers and the browser agent remain visible without this list. */
  exposedTo?: readonly string[];
}>;

export type WebMcpToolSummary = Readonly<{
  interactionId: string;
  name: string;
  title?: string;
  description: string;
  mode: InteractionMode;
  readOnlyHint: boolean;
  consequentialHint: boolean;
  debugging?: boolean;
  untrustedContentHint?: boolean;
  exposedTo?: readonly string[];
}>;

export type WebMcpClaims = Readonly<{
  label?: string;
  run?: string;
}>;

export type WebMcpContextRequest = Readonly<{
  interactionId: string;
  mode: InteractionMode;
  signal: AbortSignal;
  claims?: WebMcpClaims;
}>;

export type WebMcpFrame = (
  request: WebMcpContextRequest,
) => ClientInvokeFraming | Promise<ClientInvokeFraming>;

export type ModelContextExecuteOptions = Readonly<{
  signal?: AbortSignal;
  claims?: WebMcpClaims;
}>;

export type ModelContextTool = Readonly<{
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  execute(
    input: Record<string, unknown>,
    options?: ModelContextExecuteOptions,
  ): unknown;
  annotations?: Readonly<{
    readOnlyHint?: boolean;
    consequentialHint?: boolean;
    debugging?: boolean;
    untrustedContentHint?: boolean;
  }>;
}>;

export type ModelContextRegisterToolOptions = Readonly<{
  signal?: AbortSignal;
  exposedTo?: readonly string[];
}>;

export type ModelContextGetToolsOptions = Readonly<{
  fromOrigins?: readonly string[];
}>;

export type ModelContextRegisteredTool = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema?: object;
  window: Window;
  origin: string;
  annotations?: ModelContextTool["annotations"];
}>;

/** Browser activity only; it does not establish execution or completion. */
export type WebMcpActivity = Readonly<{ toolName: string; state: "started" | "cancelled" }>;
export type ModelContextActivityEvent = Event & Readonly<{ toolName: string }>;

/** Structural `document.modelContext` imperative API port. */
export type ModelContextPort = {
  addEventListener?(type: "toolactivated" | "toolcancel", listener: (event: ModelContextActivityEvent) => void): void;
  removeEventListener?(type: "toolactivated" | "toolcancel", listener: (event: ModelContextActivityEvent) => void): void;
  registerTool(
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ): Promise<void>;
  /** Browser-discovered tools, including current document registrations. */
  getTools?(options?: ModelContextGetToolsOptions): Promise<readonly ModelContextRegisteredTool[]>;
  /** Execute a discovered browser tool with the browser's object input API. */
  executeTool?(
    tool: ModelContextRegisteredTool,
    input?: object,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<string>;
};

export type RegisterWebMcpBindingOptions<Context> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  context(
    request: WebMcpContextRequest,
  ): Context | Promise<Context>;
  tools: readonly WebMcpTool[];
  modelContext?: ModelContextPort;
  onActivity?(activity: WebMcpActivity): void;
}>;

export type RegisterWebMcpTransportOptions = Readonly<{
  transport: ClientTransport;
  tools: readonly WebMcpTool[];
  modelContext?: ModelContextPort;
  onActivity?(activity: WebMcpActivity): void;
  frame?: WebMcpFrame;
}>;

export type WebMcpBindingSyncOptions<Context> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  tools: readonly WebMcpTool[];
}>;

export type WebMcpTransportSyncOptions = Readonly<{
  transport: ClientTransport;
  tools: readonly WebMcpTool[];
}>;

export type WebMcpSyncOptions<Context = unknown> =
  | WebMcpBindingSyncOptions<Context>
  | WebMcpTransportSyncOptions;

export type WebMcpRegistration<Context = unknown> = Readonly<{
  readonly tools: readonly WebMcpToolSummary[];
  /**
   * Explicitly replace the live Binding/tool declaration set. There is no
   * way to show a subset of a registered Binding: narrow the Projection and
   * sync a Binding of that instead.
   */
  sync(options: WebMcpSyncOptions<Context>): Promise<void>;
  dispose(): void;
}>;
