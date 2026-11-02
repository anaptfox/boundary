import { assessInteraction } from "./assessment";
import { type InvocationCoordinator } from "./coordination";
import { snapshotObserver, type InvocationObserver } from "./observation";
import { createCatalog, createProgram, hashJson, type CatalogEntry, type JsonObject } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { failHost } from "./errors";
import { metadataForInstallation } from "./install";
import { metadataForProjection } from "./projection";
import type { Admission, BindResult, BindingController, BindingInvocation, InteractionInstallation, InteractionMode, Projection, ProjectionBinding, ProjectionBindingManifest, ProjectionBindingInteraction, ProjectionSelections, ResolvedBindingMode, ResolvedBindingInteraction, UnrealizedIssue } from "./types";
import { BindingMetadata, InteractionResolution, ModeEntry, ModeResolution, bindingMetadata, bindingRevoked, resolvedMetadata } from "./binding-state";
import { createCaller } from "./caller";
import { rawInvoke } from "./dispatch";

export const PROJECTION_BINDING_DOMAIN = "boundary.projection-binding/v1";

export function assertProjectionBinding(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !bindingMetadata.has(value)
  ) {
    failHost(
      "INVALID_ARTIFACT",
      "binding",
      "an authentic successful ProjectionBinding is required",
    );
  }
}

export async function bindProjection<
  const Selections extends ProjectionSelections,
  Context = void,
>(
  projection: Projection<Selections>,
  installation: InteractionInstallation<Context>,
  options: Readonly<{
    admit: Admission<Context>;
    observation?: InvocationObserver<Context>;
    coordinate?: InvocationCoordinator<Context>;
  }>,
): Promise<BindResult<Projection<Selections>["handles"], Context>> {
  const projectionMeta = metadataForProjection(projection);
  const installationMeta = metadataForInstallation(installation);
  const admission = options?.admit;
  const observer = snapshotObserver(options?.observation);
  const coordinator = options?.coordinate;
  if (coordinator !== undefined && typeof coordinator !== "function") {
    throw new TypeError("Binding coordinator must be a function");
  }
  if (typeof admission !== "function") {
    return failHost(
      "INVALID_ADMISSION",
      "bindProjection.admit",
      "Binding requires an explicit admission function",
    );
  }
  const issues: UnrealizedIssue[] = [];
  const modeEntries: ModeEntry<Context>[] = [];
  const expectedById = new Map(
    projection.program.interactions.map((descriptor) => [
      descriptor.contract.id,
      descriptor,
    ]),
  );
  for (const entry of projectionMeta.aliases.values()) {
    const expected = expectedById.get(entry.interaction.interactionId)!;
    const actual = installationMeta.interactions.get(entry.interaction.interactionId);
    const assessment = assessInteraction(entry.interaction, expected.contract, actual && {
      contract: actual.contract,
      inputArity: actual.inputArity,
      direct: actual.direct !== undefined,
      request: actual.request !== undefined,
    }, installationMeta.state.revoked);
    issues.push(...assessment);
    if (assessment.length > 0 || !actual) continue;
    for (const mode of entry.interaction.modes) {
      const realization = (mode === "direct" ? actual.direct : actual.request)!;
      modeEntries.push(
        Object.freeze({
          alias: entry.alias,
          expected,
          actual,
          mode,
          realizationId: realization.realizationId,
        }),
      );
    }
  }
  if (issues.length > 0) {
    return Object.freeze({
      status: "unrealized",
      report: Object.freeze({
        projection: projection.manifest,
        installationId: installation.installationId,
        issues: Object.freeze(issues),
      }),
    });
  }

  return constructBinding(
    projection, installation, admission, observer, modeEntries, undefined, coordinator,
  );
}

/** Derive a caller capability without discarding its inherited admission or revocation. */
export async function restrictBinding<
  const Selections extends ProjectionSelections,
  Context,
>(
  parent: ProjectionBinding<any, Context>,
  options: Readonly<{
    projection: Projection<Selections>;
    admit: Admission<Context>;
  }>,
): Promise<BindResult<Projection<Selections>["handles"], Context>> {
  assertProjectionBinding(parent);
  const metadata = bindingMetadata.get(parent)! as BindingMetadata<Context>;
  const projection = options.projection;
  const admission = options.admit;
  const projectionMeta = metadataForProjection(projection);
  if (typeof admission !== "function") {
    return failHost(
      "INVALID_ADMISSION", "restrictBinding.admit",
      "Binding requires an explicit admission function",
    );
  }
  const issues: UnrealizedIssue[] = [];
  const modeEntries: ModeEntry<Context>[] = [];
  for (const entry of [...projectionMeta.aliases.values()].sort(
    (left, right) => compareUtf8(left.alias, right.alias),
  )) {
    const selected = entry.interaction;
    const source = metadata.interactions.get(selected.interactionId);
    const issue = (
      reason: UnrealizedIssue["reason"], message: string, mode?: InteractionMode,
    ) => {
      issues.push(Object.freeze({
        alias: entry.alias,
        interactionId: selected.interactionId,
        reason, message,
        ...(mode === undefined ? {} : { mode }),
      }));
    };
    if (metadata.installationState.revoked) {
      issue("installation-revoked", "the Installation was revoked before binding");
    } else if (bindingRevoked(metadata)) {
      issue("binding-revoked", "the parent Binding was revoked before restriction");
    }
    if (source === undefined) {
      issue("interaction-not-selected", "the parent Binding does not select this interaction");
      continue;
    }
    const first = [...source.byMode.values()][0]!;
    if (selected.expectedContractDigest !== first.manifest.expectedContractDigest) {
      issue("contract-not-selected", "the child must retain the parent's exact expected contract");
    }
    if (selected.inputArity !== source.public.inputArity) {
      issue("arity-not-selected", "the child must retain the parent's exact input arity");
    }
    for (const mode of selected.modes) {
      const resolution = source.byMode.get(mode);
      if (resolution === undefined) {
        issue("mode-not-selected", "the parent Binding does not select this mode", mode);
        continue;
      }
      modeEntries.push(Object.freeze({
        alias: entry.alias,
        expected: resolution.expected,
        actual: resolution.actual,
        mode,
        realizationId: resolution.manifest.realizationId,
      }));
    }
  }
  if (issues.length > 0 || bindingRevoked(metadata)) {
    return Object.freeze({
      status: "unrealized",
      report: Object.freeze({
        projection: projection.manifest,
        installationId: metadata.installation.installationId,
        issues: Object.freeze(issues),
      }),
    });
  }
  return constructBinding(
    projection, metadata.installation, admission, metadata.observer,
    modeEntries, metadata,
  );
}

async function constructBinding<Selections extends ProjectionSelections, Context>(
  projection: Projection<Selections>,
  installation: InteractionInstallation<Context>,
  admission: Admission<Context>,
  observer: InvocationObserver<Context> | undefined,
  modeEntries: readonly ModeEntry<Context>[],
  parent?: BindingMetadata<Context>,
  coordinator: InvocationCoordinator<Context> | undefined = parent?.coordinator,
): Promise<BindResult<Projection<Selections>["handles"], Context>> {
  const projectionMeta = metadataForProjection(projection);
  const installationMeta = metadataForInstallation(installation);

  const actualDescriptors = [
    ...new Map(
      modeEntries.map((entry) => [
        entry.actual.descriptor.contract.id,
        entry.actual.descriptor,
      ]),
    ).values(),
  ];
  const actualProgram = await createProgram(actualDescriptors);
  const actualAvailability: CatalogEntry[] = [];
  for (const descriptor of actualProgram.interactions) {
    const entries = modeEntries.filter(
      (entry) => entry.actual.contract.id === descriptor.contract.id,
    );
    const direct = entries.find((entry) => entry.mode === "direct");
    const request = entries.find((entry) => entry.mode === "request");
    actualAvailability.push({
      interactionId: descriptor.contract.id,
      ...(direct === undefined
        ? {}
        : { direct: { realizationId: direct.realizationId } }),
      ...(request === undefined
        ? {}
        : {
            request: {
              realizationId: request.realizationId,
              controlDigest: request.actual.request!.controlDigest,
              previewSchema: request.actual.request!.previewSchema,
            },
          }),
    });
  }
  const actualCatalog = createCatalog(actualProgram, actualAvailability);
  const manifestInteractions: ProjectionBindingInteraction[] = modeEntries
    .map((entry) =>
      Object.freeze({
        alias: entry.alias,
        interactionId: entry.actual.contract.id,
        expectedContractDigest: entry.expected.contractDigest,
        actualContractDigest: entry.actual.descriptor.contractDigest,
        inputArity: entry.actual.inputArity,
        mode: entry.mode,
        realizationId: entry.realizationId,
        ...(entry.mode === "request"
          ? {
              request: Object.freeze({
                controlDigest: entry.actual.request!.controlDigest,
                previewSchema: entry.actual.request!.previewSchema,
              }),
            }
          : {}),
      }),
    )
    .sort((left, right) => {
      const alias = compareUtf8(left.alias, right.alias);
      return alias === 0 ? compareUtf8(left.mode, right.mode) : alias;
    });
  const identity = Object.freeze({
    version: 1,
    projectionDigest: projection.projectionDigest,
    installationId: installation.installationId,
    installationDigest: installation.manifest.installationDigest,
    expectedProgramDigest: projection.program.programDigest,
    actualProgramDigest: actualProgram.programDigest,
    expectedProgram: projection.program,
    actualProgram,
    actualCatalog,
    interactions: Object.freeze(manifestInteractions),
  });
  const bindingDigest = await hashJson(
    PROJECTION_BINDING_DOMAIN,
    identity as unknown as JsonObject,
  );
  const manifest: ProjectionBindingManifest = Object.freeze({
    ...identity,
    version: 1,
    bindingDigest,
  });

  if (installationMeta.state.revoked || (parent !== undefined && bindingRevoked(parent))) {
    const reason = installationMeta.state.revoked
      ? "installation-revoked" as const
      : "binding-revoked" as const;
    const message = installationMeta.state.revoked
      ? "the Installation was revoked before binding"
      : "the parent Binding was revoked before restriction";
    return Object.freeze({
      status: "unrealized",
      report: Object.freeze({
        projection: projection.manifest,
        installationId: installation.installationId,
        issues: Object.freeze(projection.manifest.interactions.map(selected =>
          Object.freeze({ alias: selected.alias, interactionId: selected.interactionId, reason, message }),
        )),
      }),
    });
  }

  const interactionResolutions = new Map<string, InteractionResolution<Context>>();
  let binding!: ProjectionBinding<any, Context>;
  const state = { revoked: false };
  binding = Object.freeze({
    manifest,
    connect() {
      return createCaller(binding);
    },
    resolve(interactionId: string) {
      return interactionResolutions.get(interactionId)?.public;
    },
    async invoke(invocation: BindingInvocation, context?: Context) {
      if (
        !invocation ||
        typeof invocation !== "object" ||
        (invocation.mode !== "direct" && invocation.mode !== "request")
      ) {
        return failHost(
          "INVALID_INVOCATION",
          "invocation",
          "raw invocation requires a resolved interaction, mode, and input",
        );
      }
      return rawInvoke(
        binding,
        invocation.interaction,
        invocation.mode,
        invocation.input,
        context as Context,
      );
    },
  }) as unknown as ProjectionBinding<any, Context>;
  const controller: BindingController = Object.freeze({
    get revoked() {
      return state.revoked;
    },
    revoke() {
      if (state.revoked) return false;
      state.revoked = true;
      return true;
    },
  });
  bindingMetadata.set(binding, {
    projection,
    installation,
    installationState: installationMeta.state,
    manifest,
    admission,
    ...(observer === undefined ? {} : { observer }),
    ...(coordinator === undefined ? {} : { coordinator }),
    interactions: interactionResolutions,
    state,
    ...(parent === undefined ? {} : { parent }),
  });
  for (const entry of projectionMeta.aliases.values()) {
    const manifestModes = manifestInteractions.filter(
      (interaction) => interaction.interactionId === entry.interaction.interactionId,
    );
    const publicModes: ResolvedBindingMode[] = manifestModes.map((interaction) =>
      Object.freeze({
        mode: interaction.mode,
        realizationId: interaction.realizationId,
        expectedContractDigest: interaction.expectedContractDigest,
        actualContractDigest: interaction.actualContractDigest,
        ...(interaction.request === undefined
          ? {}
          : { request: interaction.request }),
      }),
    );
    const publicResolution: ResolvedBindingInteraction = Object.freeze({
      interactionId: entry.interaction.interactionId,
      inputArity: entry.interaction.inputArity,
      modes: Object.freeze(publicModes),
    });
    const byMode = new Map<InteractionMode, ModeResolution<Context>>();
    for (const manifestEntry of manifestModes) {
      const source = modeEntries.find(
        (candidate) =>
          candidate.actual.contract.id === manifestEntry.interactionId &&
          candidate.mode === manifestEntry.mode,
      )!;
      byMode.set(
        manifestEntry.mode,
        Object.freeze({
          manifest: manifestEntry,
          expected: source.expected,
          actual: source.actual,
          sameContract:
            manifestEntry.expectedContractDigest ===
            manifestEntry.actualContractDigest,
        }),
      );
    }
    interactionResolutions.set(
      entry.interaction.interactionId,
      Object.freeze({ public: publicResolution, byMode }),
    );
    resolvedMetadata.set(publicResolution, {
      binding,
      interactionId: entry.interaction.interactionId,
    });
  }
  return Object.freeze({ status: "bound", binding, controller }) as never;
}
