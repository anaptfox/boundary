import { Fragment, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { parseRichText } from "../lib/rich-text";

// Render the exact editor schema approved by the human, not a second Markdown interpretation.
function nodeView(node: JSONContent): ReactNode {
  const children = node.content?.map((child, index) => <Fragment key={index}>{nodeView(child)}</Fragment>);
  switch (node.type) {
    case "doc": return children;
    case "paragraph": return <p>{children || <br />}</p>;
    case "heading": {
      switch (node.attrs?.level) {
        case 1: return <h1>{children}</h1>;
        case 2: return <h2>{children}</h2>;
        case 3: return <h3>{children}</h3>;
        case 4: return <h4>{children}</h4>;
        case 5: return <h5>{children}</h5>;
        case 6: return <h6>{children}</h6>;
        default: return null;
      }
    }
    case "bulletList": return <ul>{children}</ul>;
    case "orderedList": return <ol start={node.attrs?.start}>{children}</ol>;
    case "listItem": return <li>{children}</li>;
    case "blockquote": return <blockquote>{children}</blockquote>;
    case "codeBlock": return <pre><code>{children}</code></pre>;
    case "horizontalRule": return <hr />;
    case "hardBreak": return <br />;
    case "text": return (node.marks ?? []).reduce<ReactNode>((text, mark) => {
      switch (mark.type) {
        case "bold": return <strong>{text}</strong>;
        case "italic": return <em>{text}</em>;
        case "strike": return <s>{text}</s>;
        case "code": return <code>{text}</code>;
        default: return text;
      }
    }, node.text);
    default: return null;
  }
}

export function DraftContent({ body, richText }: { body: string; richText?: string }) {
  const parsed = richText ? parseRichText(richText) : undefined;
  if (richText && !parsed) return <p role="alert">This draft’s formatting could not be displayed. Request a new draft before applying.</p>;
  return parsed ? <div className="markdown-prose draft-content">{nodeView(parsed.json)}</div> : <p className="draft-content plain-draft">{body}</p>;
}
