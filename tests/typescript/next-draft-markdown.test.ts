import { describe, expect, it } from "vitest";
import { markdownDraft } from "../../examples/apps/typescript/document-workspace/lib/draft-markdown";
import { parseRichText } from "../../examples/apps/typescript/document-workspace/lib/rich-text";

describe("Markdown into the editable draft", () => {
  it("preserves headings, nested lists, inline marks, quotes and fenced code without a browser", () => {
    const draft = markdownDraft(["## Plan", "", "A **bold**, *clear*, ~~old~~ and `typed` idea.", "", "- First", "  - Nested", "", "> Quoted", "", "```ts", "const ok = true;", "```"]);
    const parsed = parseRichText(draft.richText)!;
    expect(parsed.body).toBe(draft.body);
    expect(parsed.json.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "bulletList", "blockquote", "codeBlock"]);
    expect(draft.richText).toContain('"type":"bold"');
    expect(draft.richText).toContain('"type":"italic"');
    expect(draft.richText).toContain('"type":"strike"');
    expect(draft.richText).toContain('"type":"code"');
  });
  it.each([
    "<script>alert(1)</script>", "**nested <b>HTML</b>**", "![remote](https://example.com/a.png)",
    "[link](https://example.com)", "[unsafe](javascript:alert%281%29)", "<https://example.com>",
    "| a | b |\n| - | - |\n| x | y |", "- [x] Done", "- [ ] Todo",
  ])("rejects unsupported content before it becomes a proposal: %s", (source) => {
    expect(() => markdownDraft(source.split("\n"))).toThrow();
  });
  it("allows HTML as inert code and bounds the complete joined source", () => {
    expect(markdownDraft(["```html", "<script>alert(1)</script>", "```"]).body).toContain("<script>");
    expect(() => markdownDraft(["x".repeat(8000), "y".repeat(8000)])).toThrow();
    expect(() => markdownDraft(["## Heading\nCollapsed line entry"])).toThrow();
    expect(() => markdownDraft([""])).toThrow();
  });
  it.each([1, 2, 3, 4, 5, 6])("preserves a level-%i Markdown heading", (level) => {
    const draft = markdownDraft([`${"#".repeat(level)} Section`]);
    expect(parseRichText(draft.richText)?.json.content?.[0]?.attrs?.level).toBe(level);
  });
});
