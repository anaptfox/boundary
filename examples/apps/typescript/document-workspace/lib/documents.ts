import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRichText } from "./rich-text";

export type Document = Readonly<{
  id: "doc-1";
  title: string;
  body: string;
  richText?: string;
  revision: number;
}>;

function dataPath(): string {
  return path.join(process.env.BOUNDARY_FOLIO_DATA_DIR ?? path.join(process.cwd(), "data"), "documents.json");
}

async function all(): Promise<Document[]> {
  try {
    return JSON.parse(await readFile(dataPath(), "utf8")) as Document[];
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return [{
      id: "doc-1",
      title: "Launch brief",
      body: "A persisted document shared by the two demo sessions.",
      revision: 1,
    }];
  }
}

export class DocumentConflictError extends Error {
  constructor(readonly actualRevision: number) {
    super("document revision no longer matches");
  }
}

let writes: Promise<void> = Promise.resolve();

export async function readDocument(id: string): Promise<Document | undefined> {
  return (await all()).find((document) => document.id === id);
}

export async function saveDocument(
  input: Pick<Document, "id" | "title" | "body" | "richText"> & Readonly<{ expectedRevision: number }>,
): Promise<Document> {
  const rich = input.richText === undefined ? undefined : parseRichText(input.richText);
  if (input.richText !== undefined && !rich) throw new Error("invalid rich text");
  let resolve!: () => void;
  const previous = writes;
  writes = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  await previous;
  try {
    const documents = await all();
    const index = documents.findIndex((document) => document.id === input.id);
    if (index < 0) throw new Error("document not found");
    const current = documents[index]!;
    if (current.revision !== input.expectedRevision) {
      throw new DocumentConflictError(current.revision);
    }
    const next: Document = Object.freeze({
      id: input.id,
      title: input.title,
      body: rich?.body ?? input.body,
      ...(rich ? { richText: JSON.stringify(rich.json) } : {}),
      revision: current.revision + 1,
    });
    documents[index] = next;
    const target = dataPath();
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(documents, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return next;
  } finally {
    resolve();
  }
}
