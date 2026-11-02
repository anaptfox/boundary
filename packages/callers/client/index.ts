export {
  createSurfaceClient,
  handlesFromBinding,
  pinSurfaceReferences,
  createInvocationState,
  createProposalInteraction,
  type HandlesFromBinding,
  type SurfaceClient,
  type AuthorizedStatusReader,
  type InteractionPhase,
  type InvocationState,
  type InvocationStateOptions,
  type InvocationStateSnapshot,
  type ProposalInteraction,
  type ProposalStatusSnapshot,
} from "./client";

export {
  createInteractionCacheScope,
  footprintsFor,
  indexInteractionFootprints,
  invalidateReadsForChange,
  invalidateReadsForObservation,
  refreshReadsForClient,
  isReadInteraction,
  mountRead,
  peekFootprints,
  readInvalidatedBy,
  watchInteraction,
  type FootprintSource,
  type InteractionCacheScope,
  type InteractionFootprint,
  type InteractionRead,
  type InteractionReadError,
  type InteractionReadSnapshot,
  type WatchInteractionOptions,
} from "./cache";

export { subscribeToObservations, type ObservationSubscription, type ObservationClientOptions } from "./observations";

export type { ClientInvokeFraming, ClientTransport } from "./transport";
