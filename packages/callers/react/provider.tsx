"use client";

import type { SurfaceClient } from "@foxworth/boundary/client";
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";

export type SurfaceProviderProps<Value extends SurfaceClient> = {
  readonly client: Value;
  readonly children?: ReactNode;
};

export type SurfaceViewProps<Value extends SurfaceClient> = {
  readonly client: Value;
};

export type SurfaceView<
  Value extends SurfaceClient,
  Props extends object = object,
> =
  ComponentType<Props & SurfaceViewProps<Value>>;

export type BoundSurfaceView<Props extends object = object> =
  ComponentType<Props>;

export type SurfaceContext<Value extends SurfaceClient> = Readonly<{
  Provider: ComponentType<SurfaceProviderProps<Value>>;
  useClient(): Value;
  /** Declare a view explicitly and inject only the client it needs. */
  view<Props extends object>(
    component: SurfaceView<Value, Props>,
  ): BoundSurfaceView<Props>;
}>;

/**
 * Create one typed React boundary for a browser client.
 *
 * It never inspects the program, chooses a view, or carries server authority.
 */
export function createSurfaceContext<
  Value extends SurfaceClient = SurfaceClient,
>(): SurfaceContext<Value> {
  const Context = createContext<Value | undefined>(undefined);

  function Provider({ client, children }: SurfaceProviderProps<Value>) {
    return createElement(Context.Provider, { value: client }, children);
  }

  function useClient(): Value {
    const client = useContext(Context);
    if (!client) {
      throw new Error(
        "CompiledSurface view must be rendered inside its CompiledSurface Provider",
      );
    }
    return client;
  }

  function view<Props extends object>(
    Component: SurfaceView<Value, Props>,
  ): BoundSurfaceView<Props> {
    function BoundView(props: Props) {
      const client = useClient();
      return createElement(Component, {
        ...props,
        client,
      } as Props & SurfaceViewProps<Value>);
    }
    BoundView.displayName = `SurfaceView(${Component.displayName ?? Component.name ?? "Anonymous"})`;
    return BoundView;
  }

  return Object.freeze({ Provider, useClient, view });
}
