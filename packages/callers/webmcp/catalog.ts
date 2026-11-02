import type { InteractionMode, ProjectionBindingManifest } from "@foxworth/boundary";
import { createCheckedHandoff, validateProjectionBindingManifest, validateHandoffResponse, type CheckedHandoff, type HandoffInvocation } from "@foxworth/boundary/handoff";
import type { ClientInvokeFraming, ClientTransport } from "@foxworth/boundary/client";
import { RemoteInvocationError } from "@foxworth/boundary/remote";
import type { JsonValue } from "@foxworth/boundary/program";
import { compileBindingResolution, interactionKey, seamOf, type ResolvedBindingInteraction } from "@foxworth/boundary/remote";
import { isObjectInputSchema, overlayInputSchema, stableJson } from "./schema";
import type { WebMcpBindingSyncOptions, WebMcpSyncOptions, WebMcpToolSummary } from "./types";
import { TOOL_NAME, fail, inputAnnotations, toolDeclarations } from "./tools";

export type PreparedTool<Context> = Readonly<{
  interactionId: string;
  name: string;
  title?: string;
  description: string;
  readOnlyHint: boolean;
  consequentialHint: boolean;
  debugging?: boolean;
  untrustedContentHint?: boolean;
  exposedTo?: readonly string[];
  mode: InteractionMode;
  inputArity: 0 | 1;
  inputSchema: JsonValue;
  identity: string;
  summary: WebMcpToolSummary;
  handoff: CheckedHandoff<Context>;
  manifest: ProjectionBindingManifest;
  resolution: ResolvedBindingInteraction;
}>;

function isBindingSync<Context>(
  options: WebMcpSyncOptions<Context>,
): options is WebMcpBindingSyncOptions<Context> {
  return "caller" in options;
}

async function handoffFromTransport(
  transport: ClientTransport,
): Promise<CheckedHandoff<unknown>> {
  if (
    !transport ||
    typeof transport.inspect !== "function" ||
    typeof transport.invoke !== "function"
  ) {
    fail(
      "INVALID_TOOL",
      "transport",
      "transport must provide inspect() and invoke()",
    );
  }
  let inspected: unknown;
  try {
    inspected = await transport.inspect();
  } catch {
    fail("INVALID_TOOL", "transport.inspect", "the Binding handshake failed");
  }
  const manifest = await validateProjectionBindingManifest(inspected);
  return Object.freeze({
    manifest,
    async invoke(invocation: HandoffInvocation, _context?: unknown, framing?: ClientInvokeFraming) {
      let outcome: unknown;
      try {
        outcome = await transport.invoke(invocation, framing);
      } catch {
        throw new RemoteInvocationError("transport", "the remote request may have started but no outcome was received");
      }
      try {
        return await validateHandoffResponse(manifest, invocation, outcome);
      } catch {
        throw new RemoteInvocationError("response", "the remote response is invalid; its consequence is unknown");
      }
    },
  });
}

export async function prepareCatalog<Context>(
  syncOptions: WebMcpSyncOptions<Context>,
): Promise<PreparedTool<Context>[]> {
  for (const [index, declaration] of syncOptions.tools.entries()) {
    if (!toolDeclarations.has(declaration)) {
      fail(
        "INVALID_TOOL",
        `tools[${index}]`,
        "tools must be created by webMcpTool()",
      );
    }
  }
  const handoff = isBindingSync(syncOptions)
    ? await createCheckedHandoff(seamOf(syncOptions.caller, "sync.caller"))
    : await handoffFromTransport(syncOptions.transport);
  const compiled = await compileBindingResolution(
    handoff,
    syncOptions.tools.map((declaration) => ({
      handle: declaration.handle,
      mode: declaration.mode,
    })),
  );
  const prepared: PreparedTool<Context>[] = [];
  const names = new Set<string>();

  for (const [index, declaration] of syncOptions.tools.entries()) {
    const interactionId = declaration.handle.interactionId;
    const resolution = compiled.interactions.get(
      interactionKey(interactionId, declaration.mode),
    )!;
    const name = declaration.name ?? interactionId;
    const path = `tools[${index}]`;
    if (!TOOL_NAME.test(name)) {
      fail(
        "INVALID_TOOL",
        `${path}.name`,
        declaration.name === undefined
          ? "interaction ID is not a valid WebMCP tool name; supply webMcpTool({ name })"
          : "tool name must start with a letter or digit and contain only letters, digits, dot, dash, or underscore",
      );
    }
    if (names.has(name)) {
      fail("DUPLICATE_NAME", `${path}.name`, `duplicate WebMCP tool name: ${name}`);
    }
    names.add(name);

    const description =
      declaration.description ??
      resolution.expected.docs.description ??
      resolution.expected.docs.summary;
    if (typeof description !== "string" || !description.trim()) {
      fail(
        "INVALID_TOOL",
        `${path}.description`,
        "tool description is required (declaration, interaction description, or summary)",
      );
    }

    const contractInput =
      resolution.handle.inputArity === 0
        ? ({
            type: "object",
            properties: {},
            additionalProperties: false,
          } as const)
        : resolution.expected.contract.inputSchema;
    const inputSchema = overlayInputSchema(
      contractInput,
      inputAnnotations(resolution.expected),
    );
    if (!isObjectInputSchema(inputSchema)) {
      fail(
        "INVALID_TOOL",
        `${path}.inputSchema`,
        "WebMCP tools require an object-shaped one-input contract",
      );
    }

    const readOnlyHint = resolution.expected.contract.changes.length === 0;
    const consequentialHint = declaration.consequentialHint ??
      (resolution.mode === "direct" && !readOnlyHint);
    const summary = Object.freeze({
      interactionId,
      name,
      ...(declaration.title === undefined ? {} : { title: declaration.title }),
      description,
      mode: resolution.mode,
      readOnlyHint,
      consequentialHint,
      ...(declaration.debugging === undefined ? {} : { debugging: declaration.debugging }),
      ...(declaration.untrustedContentHint === undefined
        ? {}
        : { untrustedContentHint: declaration.untrustedContentHint }),
      ...(declaration.exposedTo === undefined
        ? {}
        : { exposedTo: declaration.exposedTo }),
    });
    const identity = stableJson({
      name,
      contractDigest: resolution.binding.expectedContractDigest,
      mode: resolution.mode,
      inputSchema,
      exposedTo: declaration.exposedTo ?? null,
      title: declaration.title ?? null,
      description,
      consequentialHint,
      debugging: declaration.debugging ?? null,
      untrustedContentHint: declaration.untrustedContentHint ?? null,
    });

    prepared.push(
      Object.freeze({
        interactionId,
        name,
        ...(declaration.title === undefined ? {} : { title: declaration.title }),
        description,
        readOnlyHint,
        consequentialHint,
        ...(declaration.debugging === undefined ? {} : { debugging: declaration.debugging }),
        ...(declaration.untrustedContentHint === undefined
          ? {}
          : { untrustedContentHint: declaration.untrustedContentHint }),
        ...(declaration.exposedTo === undefined
          ? {}
          : { exposedTo: declaration.exposedTo }),
        mode: resolution.mode,
        inputArity: resolution.handle.inputArity,
        inputSchema,
        identity,
        summary,
        handoff,
        manifest: compiled.manifest,
        resolution,
      }),
    );
  }

  return prepared;
}

export function hostNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "InvalidStateError" ||
    /already (registered|exists)|duplicate/iu.test(message)
  );
}
