import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProjectionClient,
} from "@foxworth/boundary/client";
import {
  createProjectionContext,
  useInteraction,
  type ProjectionProviderProps,
  type ProjectionViewProps,
} from "@foxworth/boundary/react";
import { describe, expect, it } from "vitest";

type TodoProjectionClient = ProjectionClient &
  Readonly<{ surface: "todo-projection" }>;

describe("@foxworth/boundary/react", () => {
  it("creates a typed Projection client context with explicit views", () => {
    const react = createProjectionContext<TodoProjectionClient>();
    const client = Object.freeze({}) as TodoProjectionClient;

    function TodoView(
      _props: ProjectionViewProps<TodoProjectionClient> & {
        readonly heading: string;
      },
    ) {
      return null;
    }

    const BoundView = react.view(TodoView);
    const providerElement = (
      react.Provider as (
        props: ProjectionProviderProps<TodoProjectionClient>,
      ) => { readonly props: { readonly value: TodoProjectionClient } }
    )({ client, children: "child" });

    expect(Object.isFrozen(react)).toBe(true);
    expect(typeof react.Provider).toBe("function");
    expect(typeof react.useClient).toBe("function");
    expect(typeof useInteraction).toBe("function");
    expect(typeof BoundView).toBe("function");
    expect(BoundView.displayName).toBe("ProjectionView(TodoView)");
    expect(providerElement.props.value).toBe(client);
  });

  it("contains no app, program-derived view, or server-authority logic", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const source = await readFile(
      path.join(root, "packages/callers/react/provider.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(
      /\bApp\b|inspect\(|program\.interactions|routeFor|target\s*===|verb\s*===|authorize|HttpHandler/,
    );
  });

  it("consumes the projector-owned read store instead of a second React cache", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const source = await readFile(
      path.join(root, "packages/callers/react/use-interaction.ts"),
      "utf8",
    );

    expect(source).toContain("watchInteraction");
    expect(source).toContain("useSyncExternalStore");
    expect(source).not.toContain("mountRead(");
  });
});
