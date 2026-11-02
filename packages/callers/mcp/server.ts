import type {
  InteractionMode,
  ProjectionBinding,
  ProjectionBindingManifest,
} from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import {
  createCheckedHandoff,
  createHandoffInvocation,
  type HandoffFaultCause,
  type HandoffOutcome,
} from "@foxworth/boundary/handoff";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import {
  createMcpHandler as createMcpHttpHandler,
  fromJsonSchema,
  McpServer,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type ServerContext,
  type ScopeChallengeHandler,
  type McpServerOptions,
} from "@modelcontextprotocol/server";
import {
  compileBindingResolution,
  modeForHandle,
  interactionKey,
  snapshotProjectedHandle,
  type AnyProjectedInteractionHandle,
  type ResolvedBindingInteraction,
} from "@foxworth/boundary/remote";
import { AdapterError } from "@foxworth/boundary/remote";

export type McpTool<
  Value extends AnyProjectedInteractionHandle = AnyProjectedInteractionHandle,
> = Readonly<{
  handle: Value;
  mode: InteractionMode;
  name: string;
  title?: string;
  description?: string;
  /** Host-owned scope preflight; it never widens the Binding. */
  scopeChallenge?: ScopeChallengeHandler;
}>;

const toolDeclarations = new WeakSet<object>();
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

function detachedJsonSchema(schema: JsonSchemaType): JsonSchemaType {
  // Program contracts are immutable identity data. Some validator providers
  // annotate schemas while compiling them, so the adapter must own the value it
  // hands across that boundary. structuredClone also detaches nested schemas.
  return structuredClone(schema) as JsonSchemaType;
}

export function tool<Value extends AnyProjectedInteractionHandle>(
  handleValue: Value,
  options: Readonly<{
    mode?: Value["modes"][number];
    name?: string;
    title?: string;
    description?: string;
    scopeChallenge?: ScopeChallengeHandler;
  }> = {},
): McpTool<Value> {
  const handle = snapshotProjectedHandle(handleValue, "tool.handle");
  const mode = modeForHandle(handle, options.mode, "tool.mode");
  const name = options.name ?? handle.interactionId;
  if (!TOOL_NAME.test(name)) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "tool.name",
      "tool name must start with a letter and contain only letters, digits, dot, dash, or underscore",
    );
  }
  if (options.title !== undefined && !options.title.trim()) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "tool.title",
      "tool title must not be empty",
    );
  }
  if (options.description !== undefined && !options.description.trim()) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "tool.description",
      "tool description must not be empty",
    );
  }
  const declaration = Object.freeze({
    handle,
    mode,
    name,
    ...(options.scopeChallenge === undefined ? {} : { scopeChallenge: options.scopeChallenge }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
  });
  toolDeclarations.add(declaration);
  return declaration;
}

export type McpContextRequest = Readonly<{
  tool: McpTool;
  extra: ServerContext;
  request?: Request;
}>;

export type CreateMcpServerOptions<Context> = Readonly<{
  binding: ProjectionBinding<any, Context>;
  context(request: McpContextRequest): Context | Promise<Context>;
  /**
   * How the Binding's interactions are presented: names and modes. This is a
   * fixed list, never a per-request predicate. Omitting a projected interaction
   * here hides nothing the Binding still carries; narrow the Projection when
   * a model must not see an interaction.
   */
  tools: readonly McpTool[];
  /** Host-owned MCP server identity. */
  name: string;
  version: string;
  /** Bound server-side input validation work without changing authority. */
  maxToolInputElements?: McpServerOptions["maxToolInputElements"];
}>;

function mcpResult(outcome: HandoffOutcome) {
  const text = JSON.stringify(outcome, null, 2);
  const successful =
    outcome.result.kind === "returned" || outcome.result.kind === "proposed";
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: outcome as unknown as Record<string, unknown>,
    ...(successful ? {} : { isError: true as const }),
  };
}

function failureOutcome(
  manifest: ProjectionBindingManifest,
  resolved: ResolvedBindingInteraction,
  certainty: "not-started" | "unknown",
  cause: HandoffFaultCause,
): HandoffOutcome {
  return Object.freeze({
    version: 1,
    bindingDigest: manifest.bindingDigest,
    installationId: manifest.installationId,
    interactionId: resolved.binding.interactionId,
    expectedContractDigest: resolved.binding.expectedContractDigest,
    actualContractDigest: resolved.binding.actualContractDigest,
    mode: resolved.binding.mode,
    realizationId: resolved.binding.realizationId,
    certainty,
    result: Object.freeze({ kind: "fault", cause }),
  });
}

function inputSchemaFor(resolved: ResolvedBindingInteraction): JsonSchemaType {
  if (resolved.handle.inputArity === 0) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }
  const schema = resolved.expected.contract.inputSchema;
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    schema.type !== "object"
  ) {
    throw new AdapterError(
      "UNSUPPORTED_SCHEMA",
      `${resolved.handle.interactionId}.inputSchema`,
      "MCP tools require an object-shaped one-input contract",
    );
  }
  return schema as JsonSchemaType;
}

/** Create a library-only MCP server from explicit projected-handle tools. */
export async function createMcpServer<Context>(
  options: CreateMcpServerOptions<Context>,
): Promise<McpServer> {
  if (typeof options.context !== "function") {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "createMcpServer.context",
      "context must resolve invocation-scoped host context",
    );
  }
  if (!options.name.trim() || !options.version.trim()) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "createMcpServer.identity",
      "name and version must be explicit non-empty host values",
    );
  }
  for (const [index, declaration] of options.tools.entries()) {
    if (!toolDeclarations.has(declaration)) {
      throw new AdapterError(
        "INVALID_DECLARATION",
        `tools[${index}]`,
        "tools must be created by tool()",
      );
    }
  }

  const handoff = await createCheckedHandoff(options.binding);
  const resolution = await compileBindingResolution(
    handoff,
    options.tools.map((entry) => ({
      handle: entry.handle,
      mode: entry.mode,
    })),
  );
  const names = new Set<string>();
  const server = new McpServer({ name: options.name, version: options.version }, {
    supportedProtocolVersions: ["2026-07-28"],
    ...(options.maxToolInputElements === undefined ? {} : { maxToolInputElements: options.maxToolInputElements }),
  });

  for (const declaration of options.tools) {
    if (names.has(declaration.name)) {
      throw new AdapterError(
        "DUPLICATE_DECLARATION",
        `tools.${declaration.name}`,
        `duplicate MCP tool name: ${declaration.name}`,
      );
    }
    names.add(declaration.name);
    const resolved = resolution.interactions.get(
      interactionKey(declaration.handle.interactionId, declaration.mode),
    )!;
    const description =
      declaration.description ??
      resolved.expected.docs.description ??
      resolved.expected.docs.summary;
    server.registerTool(
      declaration.name,
      {
        ...(declaration.title === undefined
          ? {}
          : { title: declaration.title }),
        ...(description === undefined ? {} : { description }),
        ...(declaration.scopeChallenge === undefined ? {} : { scopeChallenge: declaration.scopeChallenge }),
        annotations: {
          readOnlyHint: resolved.expected.contract.changes.length === 0,
        },
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          detachedJsonSchema(inputSchemaFor(resolved)),
        ),
      },
      async (input, extra) => {
        let invocation;
        try {
          invocation = await createHandoffInvocation(
            resolution.manifest,
            resolved.handle.interactionId,
            resolved.mode,
            resolved.handle.inputArity === 0
              ? null
              : (input as unknown as JsonValue),
          );
        } catch {
          return mcpResult(
            failureOutcome(
              resolution.manifest,
              resolved,
              "not-started",
              "invalid-input",
            ),
          );
        }
        let context: Context;
        try {
          const request = extra.http?.req;
          context = await options.context({
            tool: declaration,
            extra,
            ...(request === undefined ? {} : { request }),
          });
        } catch {
          return mcpResult(
            failureOutcome(
              resolution.manifest,
              resolved,
              "not-started",
              "invalid-invocation",
            ),
          );
        }
        try {
          return mcpResult(await handoff.invoke(invocation, context));
        } catch {
          // A checked invocation is never repeated or rebound. If validation of
          // the only outcome fails after dispatch, its completion is unknown.
          return mcpResult(
            failureOutcome(
              resolution.manifest,
              resolved,
              "unknown",
              "realization-failed",
            ),
          );
        }
      },
    );
  }
  return server;
}

export type BoundaryMcpHttpOptions = Omit<CreateMcpHandlerOptions, "legacy">;

export function createMcpHandler<Context>(
  options: CreateMcpServerOptions<Context>,
  handlerOptions?: BoundaryMcpHttpOptions,
): McpHttpHandler {
  return createMcpHttpHandler(() => createMcpServer(options), { ...handlerOptions, legacy: "reject" });
}

export type ToolSource = Readonly<{
  readonly handles: Readonly<Record<string, AnyProjectedInteractionHandle>>;
}>;

/** One MCP tool per projected handle, using each handle's default mode. */
export function toolsFor(
  projection: ToolSource,
): McpTool[] {
  return Object.values(projection.handles).map((handle) => tool(handle));
}
