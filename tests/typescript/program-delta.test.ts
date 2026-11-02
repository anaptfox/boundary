import { describe, expect, it } from "vitest";
import {
  ProgramError,
  contractChanges,
  contractCompatibility,
  type InteractionContract,
} from "@foxworth/boundary/program";

function contract(overrides: Partial<InteractionContract> = {}): InteractionContract {
  return {
    version: 1,
    id: "feed.list",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    reads: ["store"],
    changes: [],
    ...overrides,
  };
}

describe("contractChanges", () => {
  it("reports no change for identical declarations", () => {
    expect(contractChanges(contract(), contract())).toEqual({
      changes: [],
      existingCallers: { compatible: true },
    });
  });

  it("names an optional output addition that existing callers can accept", () => {
    const before = contract();
    const after = contract({
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, reply_url: { type: "string" } },
        required: ["title"],
      },
    });

    const delta = contractChanges(before, after);
    expect(delta.changes).toEqual([
      { path: "outputSchema.properties.reply_url", kind: "added", after: { type: "string" } },
    ]);
    expect(delta.existingCallers).toEqual({ compatible: true });
  });

  it.each(["reads", "changes"] as const)(
    "names a wider %s footprint and rejects it for existing callers",
    (field) => {
      const before = contract({ [field]: ["store"] });
      const after = contract({ [field]: ["store", "github"] });
      const delta = contractChanges(before, after);

      expect(delta.changes).toEqual([
        { path: field, kind: "changed", before: ["store"], after: ["github", "store"] },
      ]);
      expect(delta.existingCallers).toEqual(contractCompatibility(before, after));
      expect(delta.existingCallers.compatible).toBe(false);
    },
  );

  it("reports the removed property and its previous value", () => {
    const before = contract({
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" } },
        required: ["title"],
      },
    });

    expect(contractChanges(before, contract()).changes).toEqual([
      { path: "outputSchema.properties.url", kind: "removed", before: { type: "string" } },
    ]);
  });

  it("explains a changed nested bound with its old and new values", () => {
    const before = contract({
      outputSchema: { type: "object", properties: { count: { type: "number", maximum: 10 } } },
    });
    const after = contract({
      outputSchema: { type: "object", properties: { count: { type: "number", maximum: 20 } } },
    });
    const delta = contractChanges(before, after);

    expect(delta.changes).toEqual([
      { path: "outputSchema.properties.count.maximum", kind: "changed", before: 10, after: 20 },
    ]);
    expect(delta.existingCallers).toEqual(contractCompatibility(before, after));
    expect(delta.existingCallers.compatible).toBe(false);
  });

  it("keeps an unchanged nullable field compatible when an output field is added", () => {
    const ci = { anyOf: [{ type: "string" }, { type: "null" }] };
    const before = contract({ outputSchema: { type: "object", properties: { ci } } });
    const after = contract({
      outputSchema: { type: "object", properties: { ci, note: { type: "string" } } },
    });

    expect(contractChanges(before, after)).toEqual({
      changes: [
        { path: "outputSchema.properties.note", kind: "added", after: { type: "string" } },
      ],
      existingCallers: { compatible: true },
    });
  });

  it("uses the existing matcher when an output becomes nullable", () => {
    const before = contract({ outputSchema: { type: "string" } });
    const after = contract({ outputSchema: { anyOf: [{ type: "string" }, { type: "null" }] } });
    const delta = contractChanges(before, after);

    expect(delta.existingCallers).toEqual(contractCompatibility(before, after));
    expect(delta.existingCallers.compatible).toBe(false);
    expect(delta.changes).toEqual([
      { path: "outputSchema.anyOf", kind: "added", after: [{ type: "string" }, { type: "null" }] },
      { path: "outputSchema.type", kind: "removed", before: "string" },
    ]);
  });

  it("distinguishes an absent schema from a JSON null value", () => {
    const withError = contract({ errorSchema: { const: null } });
    const addition = contractChanges(contract(), withError).changes[0];

    expect(addition).toEqual({ path: "errorSchema", kind: "added", after: { const: null } });
    expect(Object.hasOwn(addition, "before")).toBe(false);
    expect(contractChanges(withError, contract({ errorSchema: { const: "failed" } })).changes).toEqual([
      { path: "errorSchema.const", kind: "changed", before: null, after: "failed" },
    ]);
  });

  it("ignores object insertion order and normalized footprint ordering", () => {
    const before = contract({
      outputSchema: { properties: { z: { type: "string" }, a: { type: "number" } }, type: "object" },
      reads: ["z", "a", "a"],
      changes: ["second", "first"],
    });
    const after = contract({
      outputSchema: { type: "object", properties: { a: { type: "number" }, z: { type: "string" } } },
      reads: ["a", "z"],
      changes: ["first", "second", "first"],
    });

    expect(contractChanges(before, after).changes).toEqual([]);
  });

  it("sorts paths by UTF-8 bytes, including non-BMP property names", () => {
    const before = contract({ outputSchema: { type: "object", properties: {} } });
    const after = contract({
      outputSchema: {
        type: "object",
        properties: { "\u{10000}": { type: "string" }, "\uE000": { type: "string" } },
      },
    });

    expect(contractChanges(before, after).changes.map((change) => change.path)).toEqual([
      "outputSchema.properties.\uE000",
      "outputSchema.properties.\u{10000}",
    ]);
  });

  it("reports changed arrays as whole values", () => {
    const before = contract({ outputSchema: { type: "string", enum: ["open", "closed"] } });
    const after = contract({ outputSchema: { type: "string", enum: ["open"] } });

    expect(contractChanges(before, after).changes).toEqual([
      { path: "outputSchema.enum", kind: "changed", before: ["open", "closed"], after: ["open"] },
    ]);
  });

  it("returns owned, frozen values that cannot drift with mutable inputs", () => {
    const labels = ["draft", "published"];
    const status = { type: "string", enum: labels };
    const before = contract();
    const after = contract({
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, status },
        required: ["title"],
      },
    });
    const delta = contractChanges(before, after);
    const change = delta.changes[0];
    const owned = change.after as { type: string; enum: readonly string[] };
    status.type = "number";
    labels.push("deleted");

    expect(change.after).toEqual({ type: "string", enum: ["draft", "published"] });
    expect(Object.isFrozen(delta)).toBe(true);
    expect(Object.isFrozen(delta.changes)).toBe(true);
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(delta.existingCallers)).toBe(true);
    expect(Reflect.set(owned, "type", "boolean")).toBe(false);
    expect(Reflect.set(owned.enum, 0, "deleted")).toBe(false);
  });

  it("rejects invalid contracts through the existing Program validator", () => {
    const invalid = contract({ id: "not a stable id" });

    expect(() => contractChanges(invalid, contract())).toThrow(ProgramError);
    expect(() => contractChanges(contract(), invalid)).toThrow(ProgramError);
  });

  it("keeps dotted property names as literal display labels", () => {
    const before = contract({ outputSchema: { type: "object", properties: {} } });
    const after = contract({
      outputSchema: { type: "object", properties: { "reply.url": { type: "string" } } },
    });

    expect(contractChanges(before, after).changes).toEqual([
      { path: "outputSchema.properties.reply.url", kind: "added", after: { type: "string" } },
    ]);
  });
});
