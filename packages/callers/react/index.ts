export {
  InteractionCacheProvider,
  useInteractionCacheScope,
  type InteractionCacheProviderProps,
} from "./cache-scope";

export {
  createProjectionContext,
  type BoundProjectionView,
  type ProjectionContext,
  type ProjectionProviderProps,
  type ProjectionView,
  type ProjectionViewProps,
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
