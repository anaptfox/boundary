import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Display only: no HTML execution, remote image fetches, or interaction authority. */
export function Markdown({ children }: { children: string }) {
  return <div className="markdown-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="markdown-image-note">[Image: {alt || "not loaded"}]</span>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{children}</ReactMarkdown></div>;
}
