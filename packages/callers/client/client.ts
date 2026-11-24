import type {
  AnyInteractionDefinition,
  DefinitionArity,
  DefinitionInput,
  DefinitionOutput,
  InputArity,
  InteractionHandle,
  InteractionMode,
  ProjectedInteractionHandle,
  ProjectionBindingManifest,
} from "@foxworth/boundary";
import {
  createHandoffInvocation,
  validateHandoffResponse,
  validateProjectionBindingManifest,
  type HandoffInvocation,
  type HandoffOutcome,
} from "@foxworth/boundary/handoff";
import { normalizeJson, type JsonValue } from "@foxworth/boundary/program";
import type { ClientTransport } from "./transport";
import {
  AdapterError,
  RemoteDomainError,
  RemoteExecutionError,
  RemoteInvocationError,
  RemoteProtocolRejection,
  RemoteProtocolError,
} from "@foxworth/boundary/remote";
import {
  interactionKey,
  snapshotProjectedHandle,
  type AnyProjectedInteractionHandle,
} from "@foxworth/boundary/remote";

type DefinitionOf<Handle> = Handle extends ProjectedInteractionHandle<
  InteractionHandle<infer Definition>,
  any
> ? Definition : AnyInteractionDefinition;
type HandleInput<Handle extends AnyProjectedInteractionHandle> = DefinitionInput<DefinitionOf<Handle>>;
type HandleOutput<Handle extends AnyProjectedInteractionHandle> = DefinitionOutput<DefinitionOf<Handle>>;
type HandleArity<Handle extends AnyProjectedInteractionHandle> = DefinitionArity<DefinitionOf<Handle>>;
type HandleModes<Handle extends AnyProjectedInteractionHandle> =
  Handle extends ProjectedInteractionHandle<any, infer Modes, any>
    ? Modes[number]
    : never;
type HandleRequestOutput<Handle extends AnyProjectedInteractionHandle> =
  Handle extends ProjectedInteractionHandle<any, any, infer RequestOutput>
    ? RequestOutput
    : JsonValue;
type InvocationArguments<Handle extends AnyProjectedInteractionHandle> =
  HandleArity<Handle> extends 0 ? readonly [] : readonly [input: HandleInput<Handle>];

export type ProjectionClient = Readonly<{
  inspect(): Promise<ProjectionBindingManifest>;
  call<Handle extends AnyProjectedInteractionHandle>(
    handle: Handle & ("direct" extends HandleModes<Handle> ? unknown : never),
    ...args: InvocationArguments<Handle>
  ): Promise<HandleOutput<Handle>>;
  request<Handle extends AnyProjectedInteractionHandle>(
    handle: Handle & ("request" extends HandleModes<Handle> ? unknown : never),
    ...args: InvocationArguments<Handle>
  ): Promise<HandleRequestOutput<Handle>>;
  callRaw(interactionId: string, input?: unknown): Promise<JsonValue>;
  requestRaw(interactionId: string, input?: unknown): Promise<JsonValue>;
}>;

function assertTransport(transport: ClientTransport): void {
  if (
    !transport ||
    typeof transport !== "object" ||
    typeof transport.inspect !== "function" ||
    typeof transport.invoke !== "function"
  ) {
    throw new AdapterError("INVALID_DECLARATION", "createProjectionClient.transport", "transport must provide inspect() and invoke()");
  }
}

function portableInput(interactionId: string, inputArity: 0 | 1, args: readonly unknown[]): JsonValue {
  if (args.length !== inputArity) {
    throw new AdapterError(
      "INVALID_DECLARATION",
      `${interactionId}.arguments`,
      inputArity === 0 ? "this interaction accepts no input" : "this interaction requires one input",
    );
  }
  try {
    return inputArity === 0 ? null : normalizeJson(args[0], `${interactionId}.input`);
  } catch (cause) {
    throw new AdapterError("SCHEMA_MISMATCH", `${interactionId}.input`, "input is not portable JSON", { cause });
  }
}

function throwFailure(
  outcome: HandoffOutcome,
  expectedContractDigest: ProjectedInteractionHandle["contractDigest"],
): never {
  const result = outcome.result;
  if (result.kind === "declared-error") {
    throw new RemoteDomainError(outcome.interactionId, expectedContractDigest, Object.freeze({
      code: result.code,
      details: result.details,
    }));
  }
  if (result.kind === "denied") {
    throw new RemoteProtocolError(result.code, outcome.interactionId, "the interaction was denied", outcome.certainty);
  }
  if (result.kind === "fault") {
    throw new RemoteExecutionError(
      outcome.interactionId,
      outcome.certainty,
      result.cause,
      result.issues,
    );
  }
  throw new AdapterError("INVALID_RESPONSE", "response.result", "remote returned the wrong result kind");
}

/** Build a client pinned to the first exact version 1 Binding handshake. */
export function createProjectionClient(transport: ClientTransport): ProjectionClient {
  assertTransport(transport);
  const handshake = Promise.resolve().then(async () => {
    let value: unknown;
    try {
      value = await transport.inspect();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("TRANSPORT_FAILURE", "transport.inspect", "the Binding handshake failed", { cause: error });
    }
    try {
      const manifest = validateProjectionBindingManifest(value);
      const interactions = new Map(
        manifest.interactions.map((interaction) => [
          interactionKey(interaction.interactionId, interaction.mode),
          interaction,
        ]),
      );
      return { manifest, interactions };
    } catch (cause) {
      throw new AdapterError("INVALID_RESPONSE", "transport.inspect", "the remote Binding manifest is invalid", { cause });
    }
  });
  // Own an eager handshake failure even when the caller awaits a method later.
  // The original Promise remains rejected, so every method observes that failure.
  void handshake.catch(() => {});

  async function invoke(
    mode: "direct" | "request",
    interactionId: string,
    input: JsonValue,
    handle?: AnyProjectedInteractionHandle,
  ): Promise<JsonValue> {
    const { manifest, interactions } = await handshake;
    const interaction = interactions.get(interactionKey(interactionId, mode));
    if (!interaction) {
      throw new AdapterError("INTERACTION_NOT_EXPOSED", interactionId, `${interactionId} ${mode} is absent from the pinned Binding`);
    }
    if (handle && (
      handle.contractDigest !== interaction.expectedContractDigest ||
      handle.inputArity !== interaction.inputArity ||
      !handle.modes.includes(mode)
    )) {
      throw new AdapterError("STALE_REFERENCE", interactionId, "projected handle does not match the pinned Binding");
    }
    const invocation: HandoffInvocation = await createHandoffInvocation(
      manifest,
      interactionId,
      mode,
      input,
    );
    let raw: unknown;
    try {
      raw = await transport.invoke(invocation);
    } catch (error) {
      if (error instanceof RemoteProtocolRejection) throw error;
      throw new RemoteInvocationError(
        "transport",
        "the remote invocation may have started but no outcome was received",
        { cause: error },
      );
    }
    let outcome: HandoffOutcome;
    try {
      outcome = await validateHandoffResponse(manifest, invocation, raw);
    } catch (cause) {
      throw new RemoteInvocationError(
        "response",
        "the remote invocation returned an invalid outcome; its consequence is unknown",
        { cause },
      );
    }
    if (outcome.result.kind === "returned") return outcome.result.value;
    if (outcome.result.kind === "proposed") return outcome.result.proposal;
    return throwFailure(outcome, interaction.expectedContractDigest);
  }

  return Object.freeze({
    inspect: async () => (await handshake).manifest,
    async call<Handle extends AnyProjectedInteractionHandle>(
      handleValue: Handle & ("direct" extends HandleModes<Handle> ? unknown : never),
      ...args: InvocationArguments<Handle>
    ): Promise<HandleOutput<Handle>> {
      const handle = snapshotProjectedHandle(handleValue, "client.call.handle");
      const input = portableInput(handle.interactionId, handle.inputArity, args);
      return invoke("direct", handle.interactionId, input, handle) as Promise<HandleOutput<Handle>>;
    },
    async request<Handle extends AnyProjectedInteractionHandle>(
      handleValue: Handle & ("request" extends HandleModes<Handle> ? unknown : never),
      ...args: InvocationArguments<Handle>
    ): Promise<HandleRequestOutput<Handle>> {
      const handle = snapshotProjectedHandle(handleValue, "client.request.handle");
      const input = portableInput(handle.interactionId, handle.inputArity, args);
      return invoke("request", handle.interactionId, input, handle) as Promise<
        HandleRequestOutput<Handle>
      >;
    },
    async callRaw(interactionId: string, input?: unknown): Promise<JsonValue> {
      const { interactions } = await handshake;
      const interaction = interactions.get(interactionKey(interactionId, "direct"));
      if (!interaction) {
        throw new AdapterError("INTERACTION_NOT_EXPOSED", interactionId, `${interactionId} direct is absent from the pinned Binding`);
      }
      return invoke("direct", interactionId, portableInput(interactionId, interaction.inputArity, interaction.inputArity === 0 ? [] : [input]));
    },
    async requestRaw(interactionId: string, input?: unknown): Promise<JsonValue> {
      const { interactions } = await handshake;
      const interaction = interactions.get(interactionKey(interactionId, "request"));
      if (!interaction) {
        throw new AdapterError("INTERACTION_NOT_EXPOSED", interactionId, `${interactionId} request is absent from the pinned Binding`);
      }
      return invoke("request", interactionId, portableInput(interactionId, interaction.inputArity, interaction.inputArity === 0 ? [] : [input]));
    },
  });
}

export type HandlesFromBinding = Readonly<Record<
  string,
  ProjectedInteractionHandle<InteractionHandle, readonly InteractionMode[]>
>>;

/**
 * Hydrate projected handles from a Binding `inspect()` handshake.
 * The browser never compiles interactions to call.
 */
export async function handlesFromBinding(
  client: ProjectionClient,
): Promise<HandlesFromBinding> {
  const manifest = await client.inspect();
  const byAlias = new Map<
    string,
    {
      interactionId: string;
      contractDigest: ProjectedInteractionHandle["contractDigest"];
      inputArity: InputArity;
      modes: InteractionMode[];
    }
  >();
  for (const interaction of manifest.interactions) {
    const existing = byAlias.get(interaction.alias);
    if (!existing) {
      byAlias.set(interaction.alias, {
        interactionId: interaction.interactionId,
        contractDigest: interaction.expectedContractDigest,
        inputArity: interaction.inputArity,
        modes: [interaction.mode],
      });
      continue;
    }
    if (!existing.modes.includes(interaction.mode)) {
      existing.modes.push(interaction.mode);
    }
  }
  const handles: Record<string, ProjectedInteractionHandle> = {};
  for (const [alias, spec] of byAlias) {
    Object.defineProperty(handles, alias, {
      value: Object.freeze({
        interactionId: spec.interactionId,
        contractDigest: spec.contractDigest,
        inputArity: spec.inputArity,
        modes: Object.freeze([...spec.modes].sort()),
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(handles);
}

/**
 * Validate generated, digest-pinned references against the remote Binding.
 * The reference value carries its type; callers cannot select a type argument.
 */
export async function pinProjectionReferences<
  const References extends Readonly<Record<string, AnyProjectedInteractionHandle>>,
>(
  client: ProjectionClient,
  references: References,
): Promise<References> {
  const manifest = await client.inspect();
  for (const [alias, referenceValue] of Object.entries(references)) {
    const reference = snapshotProjectedHandle(
      referenceValue,
      `pinProjectionReferences.${alias}`,
    );
    const interactions = manifest.interactions.filter(
      (candidate) => candidate.alias === alias,
    );
    const modes = interactions.map((candidate) => candidate.mode).sort();
    const pinnedModes = [...reference.modes].sort();
    if (
      interactions.length === 0
      || interactions.some((candidate) =>
        candidate.interactionId !== reference.interactionId
        || candidate.expectedContractDigest !== reference.contractDigest
        || candidate.inputArity !== reference.inputArity
      )
      || modes.length !== pinnedModes.length
      || modes.some((mode, index) => mode !== pinnedModes[index])
    ) {
      throw new AdapterError(
        "STALE_REFERENCE",
        alias,
        "generated reference does not match the pinned Binding",
      );
    }
  }
  return references;
}

export type { ClientTransport } from "./transport";

export {
  createInvocationState,
  createProposalInteraction,
  type AuthorizedStatusReader,
  type InteractionPhase,
  type InvocationState,
  type InvocationStateOptions,
  type InvocationStateSnapshot,
  type ProposalInteraction,
  type ProposalStatusSnapshot,
} from "./interaction";
