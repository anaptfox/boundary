"use client";

import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import type { InteractionCacheScope } from "@foxworth/boundary/client";

const CacheScopeContext = createContext<InteractionCacheScope | undefined>(
  undefined,
);

export type InteractionCacheProviderProps = Readonly<{
  scope: InteractionCacheScope;
  children?: ReactNode;
}>;

/** Explicitly share completed-change invalidation across descendant clients. */
export function InteractionCacheProvider({
  scope,
  children,
}: InteractionCacheProviderProps) {
  return createElement(CacheScopeContext.Provider, { value: scope }, children);
}

/** The nearest explicit scope, or undefined for the default client-local cache. */
export function useInteractionCacheScope(): InteractionCacheScope | undefined {
  return useContext(CacheScopeContext);
}
