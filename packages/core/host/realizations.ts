import type { ControlRequestContributions } from "./request-contributions";
import { metadataForControlRequestContributions } from "./request-contributions";
import type { AnyInteractionDefinition, InteractionDefinitions, RealizationId } from "./types";
import { failHost } from "./errors";

const directTag = Symbol("boundary.direct-realization");
const requestTag = Symbol("boundary.request-realization");
export interface DirectRealization<Definition extends AnyInteractionDefinition = AnyInteractionDefinition, Context = void> {
  readonly kind: "direct";
  readonly realizationId: RealizationId;
  readonly handler: (...args: any[]) => unknown;
  readonly definition?: Definition;
  readonly [directTag]: true;
  readonly context?: Context;
}
export interface RequestRealization<Definition extends AnyInteractionDefinition = AnyInteractionDefinition, Context = void> {
  readonly kind: "request";
  readonly realizationId: RealizationId;
  readonly contribution: Readonly<{ interaction: object; controlDigest: string; previewSchema: object; request: (...args: any[]) => unknown }>;
  readonly [requestTag]: true;
  readonly definition?: Definition;
  readonly context?: Context;
}
export type RealizationEntry<Definition extends AnyInteractionDefinition, Context> = DirectRealization<Definition, Context> | RequestRealization<Definition, Context> | Readonly<{ direct?: DirectRealization<Definition, Context>; request?: RequestRealization<Definition, Context> }>;
export type RealizationMap<Definitions extends InteractionDefinitions, Context> = Readonly<Partial<{ [Alias in keyof Definitions]: RealizationEntry<Definitions[Alias], Context> }>>;
export type CoLocatedInstallOptions<Definitions extends InteractionDefinitions, Context> = Readonly<{ installationId: string; realizations: RealizationMap<Definitions, Context> }>;

export function realizeDirect<Definition extends AnyInteractionDefinition = AnyInteractionDefinition, Context = void>(handler: (...args: any[]) => unknown, realizationId: RealizationId): DirectRealization<Definition, Context> {
  return Object.freeze({ kind: "direct", handler, realizationId, [directTag]: true as const });
}

export function realizeRequest<Definition extends AnyInteractionDefinition = AnyInteractionDefinition, Context = void>(contribution: ControlRequestContributions<any, Context>, realizationId: RealizationId): RequestRealization<Definition, Context> {
  const metadata = metadataForControlRequestContributions<Context>(contribution);
  if (metadata.entries.size !== 1) return failHost("INVALID_REQUEST_BINDING", "realizeRequest", "request realization requires contributions for exactly one interaction");
  return Object.freeze({ kind: "request", contribution: metadata.entries.values().next().value!, realizationId, [requestTag]: true as const });
}

export function isDirectRealization(value: unknown): value is DirectRealization {
  return value !== null && typeof value === "object" && (value as any)[directTag] === true;
}
export function isRequestRealization(value: unknown): value is RequestRealization {
  return value !== null && typeof value === "object" && (value as any)[requestTag] === true;
}
export function isRealizationPair(value: unknown): value is { direct?: unknown; request?: unknown } {
  return value !== null && typeof value === "object" && !isDirectRealization(value) && !isRequestRealization(value);
}
