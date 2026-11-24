import type { InteractionMode, ProjectionBindingManifest, ProjectionBindingInteraction } from "@foxworth/boundary/program";
import { contractCompatibility, hashJson, jsonEquals, validateCatalog, validatePortableSchema, validateProgram, type JsonObject, type InteractionDescriptor } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { ALIAS, BINDING_DOMAIN, PROJECTION_DOMAIN, descriptorById, exact, interactionKey, malformed, requireDigest, requireInteractionId, requireMode, requireOpaqueId, requireVersion, snapshot, validatedManifests } from "./checks";

function validateBindingInteraction(
  value: unknown,
  index: number,
  expected: ReadonlyMap<string, InteractionDescriptor>,
  actual: ReadonlyMap<string, InteractionDescriptor>,
): ProjectionBindingInteraction {
  const path = `manifest.interactions[${index}]`;
  const raw = exact(
    value,
    path,
    [
      "alias",
      "interactionId",
      "expectedContractDigest",
      "actualContractDigest",
      "inputArity",
      "mode",
      "realizationId",
    ],
    ["request"],
  );
  if (typeof raw.alias !== "string" || !ALIAS.test(raw.alias)) {
    malformed(`${path}.alias`, "alias must be a JavaScript identifier-like string");
  }
  requireInteractionId(raw.interactionId, `${path}.interactionId`, "manifest");
  requireDigest(raw.expectedContractDigest, `${path}.expectedContractDigest`, "manifest");
  requireDigest(raw.actualContractDigest, `${path}.actualContractDigest`, "manifest");
  if (raw.inputArity !== 0 && raw.inputArity !== 1) {
    malformed(`${path}.inputArity`, "inputArity must be 0 or 1");
  }
  requireMode(raw.mode, `${path}.mode`, "manifest");
  requireOpaqueId(raw.realizationId, `${path}.realizationId`, "manifest");
  const expectedDescriptor = expected.get(raw.interactionId);
  const actualDescriptor = actual.get(raw.interactionId);
  if (!expectedDescriptor || !actualDescriptor) {
    malformed(`${path}.interactionId`, "interaction must occur in both pinned Programs");
  }
  if (expectedDescriptor.contractDigest !== raw.expectedContractDigest) {
    malformed(`${path}.expectedContractDigest`, "expected contract digest is not pinned by expectedProgram");
  }
  if (actualDescriptor.contractDigest !== raw.actualContractDigest) {
    malformed(`${path}.actualContractDigest`, "actual contract digest is not pinned by actualProgram");
  }
  const compatibility = contractCompatibility(
    expectedDescriptor.contract,
    actualDescriptor.contract,
  );
  if (!compatibility.compatible) {
    malformed(
      `${path}.${compatibility.path}`,
      `expected and actual contracts are incompatible: ${compatibility.reason}`,
    );
  }
  let request: ProjectionBindingInteraction["request"];
  if (raw.mode === "request") {
    const requestObject = exact(
      raw.request,
      `${path}.request`,
      ["controlDigest", "previewSchema"],
    );
    requireDigest(requestObject.controlDigest, `${path}.request.controlDigest`, "manifest");
    try {
      validatePortableSchema(
        requestObject.previewSchema as JsonObject,
        `${path}.request.previewSchema`,
      );
    } catch (error) {
      malformed(`${path}.request.previewSchema`, "previewSchema is not portable", error);
    }
    request = Object.freeze({
      controlDigest: requestObject.controlDigest,
      previewSchema: requestObject.previewSchema as JsonObject,
    });
  } else if (raw.request !== undefined) {
    malformed(`${path}.request`, "request metadata is forbidden for direct mode");
  }
  return Object.freeze({
    alias: raw.alias,
    interactionId: raw.interactionId,
    expectedContractDigest: raw.expectedContractDigest,
    actualContractDigest: raw.actualContractDigest,
    inputArity: raw.inputArity,
    mode: raw.mode,
    realizationId: raw.realizationId,
    ...(request === undefined ? {} : { request }),
  });
}

/** Snapshot and fully validate an untrusted v1 Binding handshake. */
export function validateProjectionBindingManifest(
  value: unknown,
): ProjectionBindingManifest {
  if (value !== null && typeof value === "object" && validatedManifests.has(value)) {
    return value as ProjectionBindingManifest;
  }
  const owned = snapshot(value, "manifest", "manifest");
  requireVersion(
    owned !== null && typeof owned === "object" && !Array.isArray(owned)
      ? (owned as JsonObject).version
      : undefined,
    "manifest.version",
  );
  const raw = exact(owned, "manifest", [
    "version",
    "bindingDigest",
    "projectionDigest",
    "installationId",
    "installationDigest",
    "expectedProgramDigest",
    "actualProgramDigest",
    "expectedProgram",
    "actualProgram",
    "actualCatalog",
    "interactions",
  ]);
  requireVersion(raw.version, "manifest.version");
  requireDigest(raw.bindingDigest, "manifest.bindingDigest", "manifest");
  requireDigest(raw.projectionDigest, "manifest.projectionDigest", "manifest");
  requireOpaqueId(raw.installationId, "manifest.installationId", "manifest");
  requireDigest(raw.installationDigest, "manifest.installationDigest", "manifest");
  requireDigest(raw.expectedProgramDigest, "manifest.expectedProgramDigest", "manifest");
  requireDigest(raw.actualProgramDigest, "manifest.actualProgramDigest", "manifest");
  if (!Array.isArray(raw.interactions)) {
    malformed("manifest.interactions", "Binding interactions must be an array");
  }
  let expectedProgram;
  let actualProgram;
  try {
    expectedProgram = validateProgram(raw.expectedProgram as never);
    actualProgram = validateProgram(raw.actualProgram as never);
  } catch (error) {
    malformed("manifest", "pinned Programs are invalid", error);
  }
  if (expectedProgram.programDigest !== raw.expectedProgramDigest) {
    malformed("manifest.expectedProgramDigest", "expected Program digest does not match expectedProgram");
  }
  if (actualProgram.programDigest !== raw.actualProgramDigest) {
    malformed("manifest.actualProgramDigest", "actual Program digest does not match actualProgram");
  }
  let actualCatalog;
  try {
    actualCatalog = validateCatalog(actualProgram, raw.actualCatalog as never);
  } catch (error) {
    malformed("manifest.actualCatalog", "actual Catalog is invalid", error);
  }
  const expected = descriptorById(expectedProgram.interactions);
  const actual = descriptorById(actualProgram.interactions);
  const catalogById = new Map(
    actualCatalog.interactions.map((entry) => [entry.interactionId, entry]),
  );
  const interactions = Object.freeze(
    raw.interactions.map((entry, index) =>
      validateBindingInteraction(entry, index, expected, actual),
    ),
  );
  const keys = new Set<string>();
  const aliases = new Map<string, Readonly<{ interactionId: string; inputArity: 0 | 1 }>>();
  const modesByAlias = new Map<string, ProjectionBindingInteraction[]>();
  const modesById = new Map<string, Map<InteractionMode, ProjectionBindingInteraction>>();
  for (let index = 0; index < interactions.length; index += 1) {
    const interaction = interactions[index]!;
    const key = interactionKey(interaction);
    if (keys.has(key)) {
      malformed(`manifest.interactions[${index}]`, "duplicate interaction and mode entry");
    }
    keys.add(key);
    const alias = aliases.get(interaction.alias);
    if (
      alias &&
      (alias.interactionId !== interaction.interactionId ||
        alias.inputArity !== interaction.inputArity)
    ) {
      malformed(`manifest.interactions[${index}].alias`, "one alias must identify one interaction and arity");
    }
    aliases.set(interaction.alias, {
      interactionId: interaction.interactionId,
      inputArity: interaction.inputArity,
    });
    const aliasModes = modesByAlias.get(interaction.alias) ?? [];
    aliasModes.push(interaction);
    modesByAlias.set(interaction.alias, aliasModes);
    const idModes = modesById.get(interaction.interactionId) ??
      new Map<InteractionMode, ProjectionBindingInteraction>();
    idModes.set(interaction.mode, interaction);
    modesById.set(interaction.interactionId, idModes);
    const availability = catalogById.get(interaction.interactionId);
    if (!availability) {
      malformed(
        `manifest.interactions[${index}].interactionId`,
        "Catalog does not contain the pinned interaction",
      );
    }
    if (
      interaction.mode === "direct" &&
      availability.direct?.realizationId !== interaction.realizationId
    ) {
      malformed(
        `manifest.interactions[${index}].realizationId`,
        "Catalog does not pin the same direct realization",
      );
    }
    if (
      interaction.mode === "request" &&
      (availability.request?.realizationId !== interaction.realizationId ||
        availability.request?.controlDigest !== interaction.request!.controlDigest ||
        !jsonEquals(
          availability.request?.previewSchema ?? null,
          interaction.request!.previewSchema,
        ))
    ) {
      malformed(
        `manifest.interactions[${index}].request`,
        "Catalog does not pin the same request realization and control identity",
      );
    }
    if (index > 0) {
      const previous = interactions[index - 1]!;
      if (
        compareUtf8(previous.alias, interaction.alias) > 0 ||
        (previous.alias === interaction.alias &&
          compareUtf8(previous.mode, interaction.mode) >= 0)
      ) {
        malformed(`manifest.interactions[${index}]`, "interaction modes are not in canonical alias/mode order");
      }
    }
  }
  if (
    expected.size !== aliases.size ||
    actual.size !== new Set(interactions.map((interaction) => interaction.interactionId)).size
  ) {
    malformed("manifest.interactions", "Binding interactions must exhaust both pinned selected Programs");
  }
  const advertisedModeCount = actualCatalog.interactions.reduce(
    (count, entry) =>
      count + (entry.direct === undefined ? 0 : 1) +
      (entry.request === undefined ? 0 : 1),
    0,
  );
  if (advertisedModeCount !== interactions.length) {
    malformed(
      "manifest.actualCatalog.interactions",
      "Catalog modes must exactly match the pinned Binding interaction modes",
    );
  }
  const projectionInteractions = Object.freeze(
    [...aliases.entries()]
      .map(([alias, interaction]) => {
        const entries = modesByAlias.get(alias)!;
        return Object.freeze({
          alias,
          interactionId: interaction.interactionId,
          expectedContractDigest: entries[0]!.expectedContractDigest,
          inputArity: interaction.inputArity,
          modes: Object.freeze(entries.map((entry) => entry.mode).sort(compareUtf8)),
        });
      })
      .sort((left, right) => compareUtf8(left.alias, right.alias)),
  );
  const projectionDigest = hashJson(
    PROJECTION_DOMAIN,
    Object.freeze({
      program: expectedProgram.programDigest,
      interactions: Object.freeze(
        projectionInteractions.map((interaction) =>
          Object.freeze({
            alias: interaction.alias,
            interaction: interaction.interactionId,
            contract: interaction.expectedContractDigest,
            arity: interaction.inputArity === 0 ? "zero" : "one",
            modes:
              interaction.modes.length === 2
                ? "direct-and-request"
                : interaction.modes[0],
          }),
        ),
      ),
    }) as unknown as JsonObject,
  );
  if (projectionDigest !== raw.projectionDigest) {
    malformed("manifest.projectionDigest", "projection digest does not match the selected expected surface");
  }
  const identity = Object.freeze({
    version: 1 as const,
    projectionDigest: raw.projectionDigest,
    installationId: raw.installationId,
    installationDigest: raw.installationDigest,
    expectedProgramDigest: raw.expectedProgramDigest,
    actualProgramDigest: raw.actualProgramDigest,
    expectedProgram,
    actualProgram,
    actualCatalog,
    interactions,
  });
  const bindingDigest = hashJson(
    BINDING_DOMAIN,
    identity as unknown as JsonObject,
  );
  if (bindingDigest !== raw.bindingDigest) {
    malformed("manifest.bindingDigest", "binding digest does not match the pinned Binding identity");
  }
  const manifest = Object.freeze({ ...identity, bindingDigest });
  validatedManifests.set(manifest, Object.freeze({
    interactions: modesById,
    expected,
    actual,
  }));
  return manifest;
}
