export type IconName = "document" | "arrow" | "check" | "lock" | "code" | "chevron" | "close" | "bolt" | "undo" | "redo" | "list" | "quote";
const paths: Record<IconName, string> = {
  document: "M7 3h7l4 4v14H7z M14 3v5h4 M10 12h5 M10 16h5",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  check: "M5 12l4 4L19 6",
  lock: "M6 10h12v10H6z M8 10V7a4 4 0 0 1 8 0v3 M12 14v2",
  code: "m8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
  chevron: "m8 10 4 4 4-4",
  close: "m6 6 12 12 M18 6 6 18",
  bolt: "m13 2-9 12h7l-1 8 10-13h-7z",
  undo: "M4 8h10a6 6 0 0 1 0 12 M8 3 3 8l5 5",
  redo: "M20 8H10a6 6 0 0 0 0 12 M16 3l5 5-5 5",
  list: "M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1",
  quote: "M4 5h6v7H4z M4 12v2a4 4 0 0 0 4 4 M14 5h6v7h-6z M14 12v2a4 4 0 0 0 4 4",
};
export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
