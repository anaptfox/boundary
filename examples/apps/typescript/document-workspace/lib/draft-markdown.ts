import { MarkdownManager } from "@tiptap/markdown";
import { editorExtensions, parseRichText } from "./rich-text";

const manager = new MarkdownManager({ extensions: editorExtensions });

/** Convert before proposing, never during Apply. Reject unsupported content rather than lose it. */
export function markdownDraft(lines: string[]): { body: string; richText: string } {
  const source = lines.join("\n");
  if (!source.trim() || source.length > 16000 || lines.some((line) => /[\r\n]/.test(line))) {
    throw new Error("Ask Editor for a non-empty draft under 16,000 characters, with one Markdown line per entry.");
  }
  const tokens = manager.instance.lexer(source);
  manager.instance.walkTokens(tokens, (token) => {
    if (["html", "image", "link", "table"].includes(token.type) || (token.type === "list_item" && token.task)) {
      throw new Error("This editor supports headings, paragraphs, lists, quotes and code—not HTML, links, images, tables or task checkboxes. Ask Editor to preserve that content as ordinary text or lists.");
    }
  });
  const parsed = parseRichText(JSON.stringify(manager.parse(source)));
  if (!parsed || !parsed.body.trim() || parsed.body.length > 16000) throw new Error("The draft could not be represented safely in the document editor. Ask Editor to simplify its formatting.");
  return { body: parsed.body, richText: JSON.stringify(parsed.json) };
}
