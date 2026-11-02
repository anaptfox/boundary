export {
  InteractionCacheProvider,
  useInteractionCacheScope,
  type InteractionCacheProviderProps,
} from "./cache-scope";

export {
  createSurfaceContext,
  type BoundSurfaceView,
  type SurfaceContext,
  type SurfaceProviderProps,
  type SurfaceView,
  type SurfaceViewProps,
} from "./provider";

export {
  describeInteractionError,
  useInteraction,
  type DescribedInteractionError,
  type InteractionErrorKind,
  type UseInteractionError,
  type UseInteractionResult,
} from "./use-interaction";

export {
  useInvocationState,
  useProposalInteraction,
} from "./use-invocation-state";
