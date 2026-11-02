import { describe, expect, it } from "vitest";
import { NameError, witIdentifier } from "../../packages/guests/plugin/name";

function expectOk(interactionId: string, expected: string): void {
  const result = witIdentifier(interactionId);
  expect(result.ok, `expected ${interactionId} to derive a name`).toBe(true);
  if (result.ok) expect(result.value).toBe(expected);
}

function expectError(interactionId: string): NameError {
  const result = witIdentifier(interactionId);
  expect(result.ok, `expected ${interactionId} to fail`).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

describe("witIdentifier", () => {
  it("splits dots and camelCase", () => {
    expectOk("images.makeThumbnail", "images-make-thumbnail");
  });

  it("preserves existing kebab segments", () => {
    expectOk(
      "media.edit.set-node-transform",
      "media-edit-set-node-transform",
    );
  });

  it("keeps trailing digits inside a segment", () => {
    expectOk("todos.v2", "todos-v2");
  });

  it("rejects a segment starting with a digit", () => {
    const error = expectError("images.2x");
    expect(error.code).toBe("SEGMENT_START");
    expect(error.segment).toBe("2x");
  });

  it("rejects a reserved keyword", () => {
    const error = expectError("record");
    expect(error.code).toBe("RESERVED");
    expect(error.derived).toBe("record");
  });

  it("lets distinct ids derive one name (the projector, not derivation, must detect this)", () => {
    expectOk("a.bC", "a-b-c");
    expectOk("a.b-c", "a-b-c");
  });

  it("reports the derived name alongside every failure that has one", () => {
    const error = witIdentifier("images.2x");
    expect(error.ok).toBe(false);
    if (!error.ok) {
      expect(error.error).toBeInstanceOf(NameError);
      expect(error.error.interactionId).toBe("images.2x");
    }
  });
});
