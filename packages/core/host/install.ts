import {
  createCatalog,
  hashJson,
  type CatalogEntry,
  type JsonObject,
  type JsonValue,
} from "@foxworth/boundary/program";
import {
  metadataForCompiled,
  metadataForHandle,
} from "./compile";
import { failHost } from "./errors";
import {
  captureNativeDispatchOutcome,
  createNativeDispatchOutcomes,
} from "./native-outcome";
import { metadataForImplementations } from "./implement";
import { installObservedRead } from "./observations/integration";
import {
  metadataForControlRequestContributions,
  type ControlRequestContributions,
  type ControlRequestEntry,
} from "./request-contributions";
import type {
  ActualInteractionResolution,
  AnyInteractionDefinition,
  CompiledInteractions,
  InstallationId,
  InstallationManifest,
  NativeInteractionBinding,
  InteractionDefinitions,
  InteractionImplementations,
  InteractionInstallation,
  InstalledInteractions,
  RealizationId,
  RealizationIds,
  RequestInvocationPolicy,
} from "./types";

export const INSTALLATION_DOMAIN = "boundary.installation/v1";

type BareInstallOptions<
  Definitions extends InteractionDefinitions,
  Context,
> = Readonly<{
  installationId: InstallationId;
  implementations: InteractionImplementations<any, Context>;
  bindings?: never;
  requests?: ControlRequestContributions<Definitions, Context>;
  realizationIds: RealizationIds;
}>;

type NativeInstallOptions<
  Definitions extends InteractionDefinitions,
  Context,
> = Readonly<{
  installationId: InstallationId;
  implementations?: never;
  bindings: readonly {
    [Alias in keyof Definitions]: NativeInteractionBinding<
      Definitions[Alias],
      any,
      Context
    >;
  }[keyof Definitions][];
  requests?: ControlRequestContributions<Definitions, Context>;
  realizationIds: RealizationIds;
}>;

export type InstallInteractionsOptions<
  Definitions extends InteractionDefinitions,
  Context,
> =
  | BareInstallOptions<Definitions, Context>
  | NativeInstallOptions<Definitions, Context>;

type InstallationMetadata<Context> = Readonly<{
  compiled: CompiledInteractions<any>;
  interactions: ReadonlyMap<string, ActualInteractionResolution<Context>>;
  state: { revoked: boolean };
}>;

const installationMetadata = new WeakMap<object, InstallationMetadata<any>>();

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u.test(value)
  );
}

function requireInstallationId(value: unknown): InstallationId {
  if (!validOpaqueId(value)) {
    return failHost(
      "INVALID_INSTALLATION_ID",
      "installationId",
      "installationId must be a non-empty stable ASCII token",
    );
  }
  return value;
}

function requireRealizationId(
  value: unknown,
  path: string,
): RealizationId {
  if (!validOpaqueId(value)) {
    return failHost(
      "INVALID_REALIZATION_ID",
      path,
      "realizationId must be a non-empty stable ASCII token",
    );
  }
  return value;
}

function realizationRecord(value: unknown): RealizationIds {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost(
      "INVALID_REALIZATION_ID",
      "realizationIds",
      "realizationIds must be a record keyed by compiled alias",
    );
  }
  return value as RealizationIds;
}

function implementationExecutor<Context>(
  definition: AnyInteractionDefinition,
  implementation: (...args: any[]) => unknown,
): (input: JsonValue, context: Context) => Promise<unknown> {
  return async (input, context) => {
    if (definition.inputArity === 0) {
      return context === undefined
        ? implementation()
        : implementation(context);
    }
    return context === undefined
      ? implementation(input)
      : implementation(input, context);
  };
}

function aliasForHandle(
  compiled: object,
  handle: unknown,
  path: string,
): string {
  const metadata = metadataForHandle(handle);
  if (!metadata || metadata.compiled !== compiled) {
    return failHost(
      "FOREIGN_HANDLE",
      path,
      "installation entries require a handle from this compilation",
    );
  }
  return metadata.alias;
}

function requestEntries<Context>(
  requests: ControlRequestContributions<any, Context> | undefined,
) {
  const result = new Map<string, ControlRequestEntry<Context>>();
  if (requests === undefined) return result;
  const metadata = metadataForControlRequestContributions<Context>(requests);
  for (const [alias, contribution] of metadata.entries) {
    result.set(alias, contribution);
  }
  return result;
}

export async function installInteractions<
  Definitions extends InteractionDefinitions,
  Context = void,
>(
  compiled: CompiledInteractions<Definitions>,
  options: InstallInteractionsOptions<Definitions, Context>,
): Promise<InstalledInteractions<Context>> {
  const compiledMeta = metadataForCompiled(compiled);
  if (options === null || typeof options !== "object") {
    return failHost(
      "INVALID_INSTALLATION",
      "installInteractions.options",
      "installation options must be an object",
    );
  }
  const installationId = requireInstallationId(options.installationId);
  const ids = realizationRecord(options.realizationIds);
  const requests = requestEntries<Context>(options.requests);
  const observedExecutors: { clear(): void }[] = [];
  const direct = new Map<
    string,
    (input: JsonValue, context: Context) => Promise<unknown>
  >();

  if ("implementations" in options && options.implementations !== undefined) {
    const implementationMeta = metadataForImplementations(options.implementations);
    for (const [alias, definition] of Object.entries(
      implementationMeta.definitions,
    )) {
      const compiledAlias = compiledMeta.aliasesByDefinition.get(definition);
      if (compiledAlias === undefined || compiledAlias !== alias) {
        failHost(
          "FOREIGN_IMPLEMENTATIONS",
          `implementations.${alias}`,
          "implementation definitions must be members of this compilation under the same alias",
        );
      }
      const implementation = implementationMeta.functions.get(alias)!;
      const observed = installObservedRead(implementation, definition,
        compiledMeta.descriptors.get(definition.id)!.contract,
        { installationId, realizationId: ids[alias]?.direct ?? "" });
      if (observed) observedExecutors.push(observed);
      direct.set(alias, observed?.execute ?? implementationExecutor(definition, implementation));
    }
  } else if ("bindings" in options && options.bindings !== undefined) {
    if (!Array.isArray(options.bindings)) {
      failHost(
        "INVALID_INSTALLATION",
        "bindings",
        "native bindings must be an array",
      );
    }
    for (let index = 0; index < options.bindings.length; index += 1) {
      const binding = options.bindings[index]!;
      const interaction = binding?.interaction;
      const target = binding?.target;
      const dispatch = binding?.dispatch;
      if (
        binding === null ||
        typeof binding !== "object" ||
        typeof dispatch !== "function"
      ) {
        failHost(
          "INVALID_INSTALLATION",
          `bindings[${index}]`,
          "native binding requires interaction, target, and dispatch",
        );
      }
      const alias = aliasForHandle(
        compiled as object,
        interaction,
        `bindings[${index}].interaction`,
      );
      if (direct.has(alias)) {
        failHost(
          "DUPLICATE_REALIZATION",
          `bindings[${index}]`,
          `duplicate direct realization for ${alias}`,
        );
      }
      // Pin which dispatcher was installed while preserving its original
      // receiver so class/private-field dispatchers remain valid. Identity-
      // bearing interaction and target values are passed from this snapshot;
      // other receiver state remains ordinary live Host-owned state.
      const invoke = dispatch.bind(binding);
      direct.set(alias, async (input, context) => {
        const outcomes = createNativeDispatchOutcomes();
        const result = await invoke(
          Object.freeze({
            interaction,
            target,
            input,
            context,
            outcomes,
          }) as never,
        );
        return captureNativeDispatchOutcome(result, outcomes) ?? result;
      });
    }
  } else {
    failHost(
      "INVALID_INSTALLATION",
      "installInteractions.options",
      "installation requires implementations or native bindings",
    );
  }

  const expectedIdKeys = new Set([...direct.keys(), ...requests.keys()]);
  const actualIdKeys = Object.keys(ids);
  const extraIds = actualIdKeys.filter((key) => !expectedIdKeys.has(key));
  if (extraIds.length > 0) {
    failHost(
      "REALIZATION_COVERAGE_MISMATCH",
      "realizationIds",
      `realization IDs name unavailable interactions: ${extraIds.join(", ")}`,
    );
  }

  const interactions = new Map<string, ActualInteractionResolution<Context>>();
  const availability: CatalogEntry[] = [];
  for (const [alias, definition] of Object.entries(compiledMeta.definitions)) {
    const descriptor = compiledMeta.descriptors.get(definition.id)!;
    const directExecution = direct.get(alias);
    const requestBinding = requests.get(alias);
    const idEntry = ids[alias];
    if (directExecution && idEntry?.direct === undefined) {
      failHost(
        "REALIZATION_COVERAGE_MISMATCH",
        `realizationIds.${alias}.direct`,
        "direct realization requires a host-issued realization ID",
      );
    }
    if (!directExecution && idEntry?.direct !== undefined) {
      failHost(
        "REALIZATION_COVERAGE_MISMATCH",
        `realizationIds.${alias}.direct`,
        "direct realization ID has no direct implementation",
      );
    }
    if (requestBinding && idEntry?.request === undefined) {
      failHost(
        "REALIZATION_COVERAGE_MISMATCH",
        `realizationIds.${alias}.request`,
        "request realization requires a host-issued realization ID",
      );
    }
    if (!requestBinding && idEntry?.request !== undefined) {
      failHost(
        "REALIZATION_COVERAGE_MISMATCH",
        `realizationIds.${alias}.request`,
        "request realization ID has no Control contribution",
      );
    }
    const directResolution = directExecution
      ? Object.freeze({
          realizationId: requireRealizationId(
            idEntry!.direct,
            `realizationIds.${alias}.direct`,
          ),
          execute: directExecution,
        })
      : undefined;
    const requestResolution = requestBinding
      ? (() => {
          const controlDigest = requestBinding.controlDigest;
          const previewSchema = requestBinding.previewSchema;
          const request = requestBinding.request;
          return Object.freeze({
            realizationId: requireRealizationId(
              idEntry!.request,
              `realizationIds.${alias}.request`,
            ),
            controlDigest,
            previewSchema,
            async execute(
              input: JsonValue,
              context: Context,
              policy: RequestInvocationPolicy,
            ) {
              return request(input, context, policy);
            },
          });
        })()
      : undefined;
    availability.push({
      interactionId: definition.id,
      ...(directResolution === undefined
        ? {}
        : {
            direct: {
              realizationId: directResolution.realizationId,
            },
          }),
      ...(requestResolution === undefined
        ? {}
        : {
            request: {
              realizationId: requestResolution.realizationId,
              controlDigest: requestResolution.controlDigest,
              previewSchema: requestResolution.previewSchema,
            },
          }),
    });
    interactions.set(
      definition.id,
      Object.freeze({
        alias,
        definition,
        descriptor,
        contract: descriptor.contract,
        errorSchemas:
          compiledMeta.errorSchemas.get(definition.id) ?? Object.freeze({}),
        inputArity: definition.inputArity,
        ...(directResolution === undefined
          ? {}
          : { direct: directResolution }),
        ...(requestResolution === undefined
          ? {}
          : { request: requestResolution }),
      }),
    );
  }
  const catalog = createCatalog(compiled.program, availability);
  const installationDigest = await hashJson(
    INSTALLATION_DOMAIN,
    Object.freeze({
      version: 1,
      program: compiled.program,
      catalog,
    }) as unknown as JsonObject,
  );
  const manifest: InstallationManifest = Object.freeze({
    version: 1,
    installationId,
    program: compiled.program,
    catalog,
    installationDigest,
  });
  const state = { revoked: false };
  const installation: InteractionInstallation<Context> = Object.freeze({
    handles: compiled.handles,
    manifest,
    installationId,
  });
  const controller = Object.freeze({
    get revoked() {
      return state.revoked;
    },
    revoke() {
      if (state.revoked) return false;
      state.revoked = true;
      for (const executor of observedExecutors) executor.clear();
      return true;
    },
  });
  installationMetadata.set(installation, {
    compiled,
    interactions,
    state,
  });
  return Object.freeze({ installation, controller });
}

export function metadataForInstallation<Context>(
  value: InteractionInstallation<Context>,
): InstallationMetadata<Context> {
  const metadata = installationMetadata.get(value);
  if (!metadata) {
    return failHost(
      "INVALID_INSTALLATION",
      "installation",
      "an authentic InteractionInstallation value is required",
    );
  }
  return metadata;
}
