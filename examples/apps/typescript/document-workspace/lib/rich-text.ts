import { getSchema, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

// The application owns its document format. No HTML, embeds, or link execution.
export const editorExtensions = [StarterKit.configure({
  link: false,
  underline: false,
  trailingNode: false,
  heading: { levels: [1, 2, 3, 4, 5, 6] },
})];
const schema = getSchema(editorExtensions);

export function plainDocument(body: string): JSONContent {
  return {
    type: "doc",
    content: body.split("\n\n").map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    })),
  };
}

/** Validate with the same ProseMirror schema used by the editor, before effects. */
export function parseRichText(value: string): { json: JSONContent; body: string } | undefined {
  if (value.length > 100_000) return undefined;
  try {
    const json: unknown = JSON.parse(value);
    const queue: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
    let count = 0;
    while (queue.length) {
      const item = queue.pop()!;
      if (++count > 10_000 || item.depth > 24) return undefined;
      if (item.value && typeof item.value === "object") {
        for (const child of Object.values(item.value)) queue.push({ value: child, depth: item.depth + 1 });
      }
    }
    const node = schema.nodeFromJSON(json);
    if (node.type.name !== "doc") return undefined;
    node.check();
    let valid = true;
    node.descendants((child) => {
      if (child.type.name === "heading" && ![1, 2, 3, 4, 5, 6].includes(child.attrs.level)) valid = false;
    });
    if (!valid) return undefined;
    return { json: node.toJSON(), body: node.textBetween(0, node.content.size, "\n\n", "\n") };
  } catch {
    return undefined;
  }
}
