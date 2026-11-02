import {
  cloneJson,
  isSha256Digest,
  validatePortableSchema,
  type JsonSchema,
  type JsonValue,
  type Sha256Digest,
} from "@foxworth/boundary/program";
import { metadataForCompiled, metadataForHandle } from "./compile";
import { failHost } from "./errors";
import type {
  AnyInteractionDefinition,
  CompiledInteractions,
  DefinitionInput,
  MaybePromise,
  InteractionDefinitions,
  InteractionHandle,
  RequestInvocationPolicy,
} from "./types";

declare const controlRequestContributionTypes: unique symbol;

/**
 * Opaque Host contribution artifact. Installation accepts only values minted
 * and snapshotted by this module, never caller-assembled structural records.
 */
export interface ControlRequestContributions<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
  Context = unknown,
> {
  readonly [controlRequestContributionTypes]?: {
    readonly definitions: Definitions;
    readonly context: Context;
  };
}

export interface ControlRequestContributionSource<
  Definition extends AnyInteractionDefinition = AnyInteractionDefinition,
  Context = unknown,
  Proposal extends JsonValue = JsonValue,
> {
  readonly interaction: InteractionHandle<Definition>;
  readonly controlDigest: Sha256Digest;
  readonly previewSchema: JsonSchema;
  request(
    input: DefinitionInput<Definition>,
    context: Context,
    policy: RequestInvocationPolicy,
  ): MaybePromise<Proposal>;
}

export type ControlRequestContributionSources<
  Definitions extends InteractionDefinitions,
  Context,
> = Readonly<
  Partial<{
    [Alias in keyof Definitions]: ControlRequestContributionSource<
      Definitions[Alias],
      Context,
      any
    >;
  }>
>;

export type ControlRequestContributionMetadata<Context> = Readonly<{
  entries: ReadonlyMap<string, ControlRequestEntry<Context>>;
}>;

export type ControlRequestEntry<Context> = Readonly<{
  interaction: InteractionHandle;
  controlDigest: Sha256Digest;
  previewSchema: JsonSchema;
  request(
    input: JsonValue,
    context: Context,
    policy: RequestInvocationPolicy,
  ): MaybePromise<JsonValue>;
}>;

const contributionMetadata = new WeakMap<
  object,
  ControlRequestContributionMetadata<any>
>();

/**
 * @internal Support seam consumed by `@foxworth/boundary/control/host`.
 *
 * JavaScript package exports cannot authenticate which package called a
 * function. A direct caller of this support seam is therefore part of the Host
 * TCB; artifact authenticity means module-minted and mutation-safe, not that
 * arbitrary in-process request code has been proven effect-free.
 */
export function createControlRequestContributions<
  Definitions extends InteractionDefinitions,
  Context,
>(
  compiled: CompiledInteractions<Definitions>,
  sources: ControlRequestContributionSources<Definitions, Context>,
): ControlRequestContributions<Definitions, Context> {
  metadataForCompiled(compiled);
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
    return failHost(
      "INVALID_REQUEST_BINDING",
      "control.requests",
      "control request contributions must be a record",
    );
  }
  const entries = new Map<string, ControlRequestEntry<Context>>();
  for (const alias of Reflect.ownKeys(sources)) {
    if (typeof alias !== "string") {
      failHost(
        "INVALID_REQUEST_BINDING",
        `control.requests.${String(alias)}`,
        "control request contribution aliases must be strings",
      );
    }
    const property = Object.getOwnPropertyDescriptor(sources, alias);
    if (!property || !("value" in property) || !property.enumerable) {
      failHost(
        "INVALID_REQUEST_BINDING",
        `control.requests.${alias}`,
        "control request contributions must be enumerable data properties",
      );
    }
    const source = property.value as ControlRequestContributionSource;
    if (source === null || typeof source !== "object") {
      failHost(
        "INVALID_REQUEST_BINDING",
        `control.requests.${alias}`,
        "control request contribution must be an object",
      );
    }
    const interaction = source.interaction;
    const handle = metadataForHandle(interaction);
    if (!handle || handle.compiled !== compiled || handle.alias !== alias) {
      failHost(
        "FOREIGN_HANDLE",
        `control.requests.${alias}.interaction`,
        "control request contribution requires this compilation's handle under the same alias",
      );
    }
    const controlDigest = source.controlDigest;
    if (!isSha256Digest(controlDigest)) {
      failHost(
        "INVALID_REQUEST_BINDING",
        `control.requests.${alias}.controlDigest`,
        "control request contribution requires an exact control digest",
      );
    }
    const previewSchema = cloneJson(
      source.previewSchema,
      `control.requests.${alias}.previewSchema`,
    ) as JsonSchema;
    validatePortableSchema(
      previewSchema,
      `control.requests.${alias}.previewSchema`,
    );
    const request = source.request;
    if (typeof request !== "function") {
      failHost(
        "INVALID_REQUEST_BINDING",
        `control.requests.${alias}.request`,
        "control request contribution must expose proposal creation",
      );
    }
    entries.set(alias, Object.freeze({
      interaction,
      controlDigest,
      previewSchema,
      request(input: JsonValue, context: Context, policy: RequestInvocationPolicy) {
        return request.call(undefined, input as never, context, policy);
      },
    }));
  }
  const artifact = Object.freeze({}) as ControlRequestContributions<
    Definitions,
    Context
  >;
  contributionMetadata.set(artifact, Object.freeze({ entries }));
  return artifact;
}

/** @internal Host installation authenticity check. */
export function metadataForControlRequestContributions<Context>(
  value: unknown,
): ControlRequestContributionMetadata<Context> {
  if (value === null || typeof value !== "object") {
    return failHost(
      "INVALID_REQUEST_BINDING",
      "requests",
      "an authentic Host request contribution artifact is required",
    );
  }
  const metadata = contributionMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_REQUEST_BINDING",
      "requests",
      "an authentic Host request contribution artifact is required",
    );
  }
  return metadata as ControlRequestContributionMetadata<Context>;
}

export type { RequestInvocationPolicy } from "./types";
