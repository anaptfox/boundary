"use client";

import type { ProjectionClient } from "@foxworth/boundary/client";
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";

export type ProjectionProviderProps<Value extends ProjectionClient> = {
  readonly client: Value;
  readonly children?: ReactNode;
};

export type ProjectionViewProps<Value extends ProjectionClient> = {
  readonly client: Value;
};

export type ProjectionView<
  Value extends ProjectionClient,
  Props extends object = object,
> =
  ComponentType<Props & ProjectionViewProps<Value>>;

export type BoundProjectionView<Props extends object = object> =
  ComponentType<Props>;

export type ProjectionContext<Value extends ProjectionClient> = Readonly<{
  Provider: ComponentType<ProjectionProviderProps<Value>>;
  useClient(): Value;
  /** Declare a view explicitly and inject only the client it needs. */
  view<Props extends object>(
    component: ProjectionView<Value, Props>,
  ): BoundProjectionView<Props>;
}>;

/**
 * Create one typed React boundary for a browser client.
 *
 * It never inspects the program, chooses a view, or carries server authority.
 */
export function createProjectionContext<
  Value extends ProjectionClient = ProjectionClient,
>(): ProjectionContext<Value> {
  const Context = createContext<Value | undefined>(undefined);

  function Provider({ client, children }: ProjectionProviderProps<Value>) {
    return createElement(Context.Provider, { value: client }, children);
  }

  function useClient(): Value {
    const client = useContext(Context);
    if (!client) {
      throw new Error(
        "Projection view must be rendered inside its Projection Provider",
      );
    }
    return client;
  }

  function view<Props extends object>(
    Component: ProjectionView<Value, Props>,
  ): BoundProjectionView<Props> {
    function BoundView(props: Props) {
      const client = useClient();
      return createElement(Component, {
        ...props,
        client,
      } as Props & ProjectionViewProps<Value>);
    }
    BoundView.displayName = `ProjectionView(${Component.displayName ?? Component.name ?? "Anonymous"})`;
    return BoundView;
  }

  return Object.freeze({ Provider, useClient, view });
}
