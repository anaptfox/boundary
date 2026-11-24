import { createProgram, hashJson, type JsonObject } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { metadataForHandle } from "./compile";
import { failHost } from "./errors";
import type { Projection, ProjectionInteraction, ProjectionManifest } from "./types";
import { PROJECTION_DOMAIN, metadataForProjection, metadataForProjectedHandle, registerProjectionAlgebraResult, type FluentProjection } from "./projection";

export interface ProjectionAlgebraMethods {
  pick(...keys: readonly string[]): FluentProjection<any>;
  omit(...keys: readonly string[]): FluentProjection<any>;
  union(other: Projection<any>): FluentProjection<any>;
  intersect(other: Projection<any>): FluentProjection<any>;
}

type Entry = { alias: string; interaction: ProjectionInteraction; source: object };
function entries(projection: Projection<any>): Entry[] {
  const meta = metadataForProjection(projection);
  return [...meta.aliases.values()].map((value) => {
    const source = metadataForProjectedHandle(value.handle)?.source;
    if (!source || typeof source !== "object") return failHost("INVALID_PROJECTION", value.alias, "Projection source metadata is unavailable");
    return { alias: value.alias, interaction: value.interaction, source };
  });
}
function resolve(values: Entry[], key: string) {
  return values.find((entry) => entry.alias === key) ?? values.find((entry) => entry.interaction.interactionId === key);
}

export function omitProjection(projection: Projection<any>, ...keys: readonly string[]): FluentProjection<any> {
  const all = entries(projection);
  if (new Set(keys).size !== keys.length) return failHost("INVALID_PROJECTION", "omitProjection", "omit keys must be unique");
  const excluded = new Set<string>();
  for (const key of keys) {
    const entry = resolve(all, key);
    if (!entry) return failHost("INVALID_PROJECTION", `omitProjection.${key}`, "key is not in this Projection");
    if (excluded.has(entry.alias)) return failHost("INVALID_PROJECTION", "omitProjection", "omit keys must resolve to unique aliases");
    excluded.add(entry.alias);
  }
  return createAlgebraProjection(all.filter((entry) => !excluded.has(entry.alias)));
}

export function unionProjections(left: Projection<any>, right: Projection<any>): FluentProjection<any> {
  const a = entries(left), b = entries(right), merged = new Map(a.map((entry) => [entry.alias, entry]));
  for (const entry of b) {
    const old = merged.get(entry.alias);
    if (!old) { merged.set(entry.alias, entry); continue; }
    if (old.interaction.interactionId !== entry.interaction.interactionId || old.interaction.expectedContractDigest !== entry.interaction.expectedContractDigest || old.interaction.inputArity !== entry.interaction.inputArity) {
      return failHost("INVALID_PROJECTION", `union.${entry.alias}`, "same alias has incompatible interaction identity");
    }
    const modes = [...new Set([...old.interaction.modes, ...entry.interaction.modes])].sort(compareUtf8) as ("direct" | "request")[];
    const oldDescriptor = metadataForHandle(old.source)!.descriptor;
    const nextDescriptor = metadataForHandle(entry.source)!.descriptor;
    const canonical = compareUtf8(JSON.stringify(oldDescriptor), JSON.stringify(nextDescriptor)) <= 0 ? old : entry;
    merged.set(entry.alias, { ...canonical, interaction: Object.freeze({ ...old.interaction, modes: Object.freeze(modes) }) });
  }
  const ids = new Set<string>();
  for (const entry of merged.values()) {
    if (ids.has(entry.interaction.interactionId)) return failHost("DUPLICATE_PROJECTION_INTERACTION", `union.${entry.alias}`, "one Projection may select an interaction only once");
    ids.add(entry.interaction.interactionId);
  }
  return createAlgebraProjection([...merged.values()]);
}

export function intersectProjections(left: Projection<any>, right: Projection<any>): FluentProjection<any> {
  const a = new Map(entries(left).map((entry) => [entry.alias, entry]));
  const b = new Map(entries(right).map((entry) => [entry.alias, entry]));
  const result: Entry[] = [];
  for (const [alias, first] of a) {
    const second = b.get(alias); if (!second) continue;
    if (first.interaction.interactionId !== second.interaction.interactionId || first.interaction.expectedContractDigest !== second.interaction.expectedContractDigest || first.interaction.inputArity !== second.interaction.inputArity) return failHost("INVALID_PROJECTION", `intersect.${alias}`, "same alias has incompatible interaction identity");
    const modes = first.interaction.modes.filter((mode) => second.interaction.modes.includes(mode));
    if (modes.length) result.push({ ...first, interaction: Object.freeze({ ...first.interaction, modes: Object.freeze([...modes].sort(compareUtf8)) }) });
  }
  return createAlgebraProjection(result);
}

export function pickProjectionAlgebra(projection: Projection<any>, ...keys: readonly string[]): FluentProjection<any> {
  const all = entries(projection);
  if (new Set(keys).size !== keys.length) return failHost("INVALID_PROJECTION", "pickProjection", "pick keys must be unique");
  const selected: Entry[] = [], seen = new Set<string>();
  for (const key of keys) { const entry = resolve(all, key); if (!entry) return failHost("INVALID_PROJECTION", `pickProjection.${key}`, "key is not in this Projection"); if (seen.has(entry.alias)) return failHost("INVALID_PROJECTION", "pickProjection", "pick keys must resolve to unique aliases"); seen.add(entry.alias); selected.push(entry); }
  return createAlgebraProjection(selected);
}

function createAlgebraProjection(selected: Entry[]): FluentProjection<any> {
  const handles: Record<string, object> = Object.create(null), aliases = new Map<string, any>();
  const descriptorById = new Map<string, any>();
  for (const entry of selected) {
    const sourceMeta = metadataForHandle(entry.source);
    if (!sourceMeta) return failHost("INVALID_PROJECTION", entry.alias, "Projection source handle is unavailable");
    descriptorById.set(entry.interaction.interactionId, sourceMeta.descriptor);
    const handle = Object.freeze({ interactionId: entry.interaction.interactionId, contractDigest: entry.interaction.expectedContractDigest, inputArity: entry.interaction.inputArity, modes: entry.interaction.modes });
    Object.defineProperty(handles, entry.alias, { value: handle, enumerable: true });
    aliases.set(entry.alias, { alias: entry.alias, handle, interaction: entry.interaction });
  }
  const program = createProgram([...descriptorById.values()]);
  const interactions = Object.freeze([...aliases.values()].map((entry) => entry.interaction).sort((x, y) => compareUtf8(x.alias, y.alias)));
  const identity = Object.freeze({ program: program.programDigest, interactions: Object.freeze(interactions.map((item) => Object.freeze({ alias: item.alias, interaction: item.interactionId, contract: item.expectedContractDigest, arity: item.inputArity === 0 ? "zero" : "one", modes: item.modes.length === 2 ? "direct-and-request" : item.modes[0] }))) });
  const projectionDigest = hashJson(PROJECTION_DOMAIN, identity as unknown as JsonObject);
  const manifest: ProjectionManifest = Object.freeze({ version: 1, program, interactions, projectionDigest });
  Object.freeze(handles);
  const projection = Object.freeze({ program, interactions, projectionDigest, handles, manifest,
    pick: (...keys: readonly string[]) => pickProjectionAlgebra(projection, ...keys),
    omit: (...keys: readonly string[]) => omitProjection(projection, ...keys),
    union: (other: Projection<any>) => unionProjections(projection, other),
    intersect: (other: Projection<any>) => intersectProjections(projection, other),
  }) as FluentProjection<any>;
  registerProjectionAlgebraResult(projection, aliases, selected.map(({ alias, source }) => ({ alias, source })));
  return projection;
}
