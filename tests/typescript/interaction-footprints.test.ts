import {
  indexInteractionFootprints,
  readInvalidatedBy,
} from "@foxworth/boundary/client/cache";
import { describe, expect, it } from "vitest";

const footprints = indexInteractionFootprints({
  expectedProgram: {
    interactions: [
      {
        contract: {
          id: "todos.list",
          reads: ["todos"],
          changes: [],
        },
      },
      {
        contract: {
          id: "todos.create",
          reads: ["todos"],
          changes: ["todos"],
        },
      },
      {
        contract: {
          id: "notes.list",
          reads: ["notes"],
          changes: [],
        },
      },
      {
        contract: {
          id: "settings.read",
          reads: ["settings"],
          changes: [],
        },
      },
      {
        contract: {
          id: "settings.setDisplayName",
          reads: ["settings"],
          changes: ["settings"],
        },
      },
    ],
  },
});

describe("interaction footprints", () => {
  it("indexes the Binding's expected Program contracts by interaction id", () => {
    expect(footprints.get("todos.create")).toEqual({
      reads: ["todos"],
      changes: ["todos"],
    });
    expect(footprints.get("notes.list")?.changes).toEqual([]);
  });

  it("invalidates mounted reads that share a resource with a completed change", () => {
    expect(readInvalidatedBy(footprints, "todos.list", "todos.create")).toBe(true);
    expect(
      readInvalidatedBy(footprints, "settings.read", "settings.setDisplayName"),
    ).toBe(true);
  });

  it("does not invalidate reads whose footprint misses the change", () => {
    expect(readInvalidatedBy(footprints, "notes.list", "todos.create")).toBe(false);
    expect(readInvalidatedBy(footprints, "todos.list", "settings.setDisplayName")).toBe(
      false,
    );
    expect(readInvalidatedBy(footprints, "todos.list", "todos.list")).toBe(false);
  });
});
