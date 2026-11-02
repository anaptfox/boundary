import { describe, expect, it } from "vitest";
import { parseRichText, plainDocument } from "../../examples/apps/typescript/document-workspace/lib/rich-text";

describe("the Next demo's app-owned rich-text format", () => {
  it("treats existing body strings as text, not executable HTML", () => {
    const text = '<img src=x onerror="alert(1)">';
    const parsed = parseRichText(JSON.stringify(plainDocument(text)));
    expect(parsed?.body).toBe(text);
    expect(parsed?.json.content?.[0]?.content?.[0]?.type).toBe("text");
  });
  it("preserves formatting and derives the corresponding plain text", () => {
    const json = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A bold idea", marks: [{ type: "bold" }] }] }] };
    expect(parseRichText(JSON.stringify(json))).toEqual({ json, body: "A bold idea" });
  });
  it("rejects unsupported nodes, marks, invalid nesting, and heading levels", () => {
    for (const content of [
      [{ type: "script" }],
      [{ type: "text", text: "not a block" }],
      [{ type: "paragraph", content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
      [{ type: "heading", attrs: { level: 9 } }],
    ]) expect(parseRichText(JSON.stringify({ type: "doc", content }))).toBeUndefined();
  });
  it("bounds malformed and excessive payloads", () => {
    expect(parseRichText("{" )).toBeUndefined();
    expect(parseRichText("x".repeat(100_001))).toBeUndefined();
    let nested: unknown = { type: "paragraph" };
    for (let index = 0; index < 30; index++) nested = { type: "blockquote", content: [nested] };
    expect(parseRichText(JSON.stringify({ type: "doc", content: [nested] }))).toBeUndefined();
  });
});
