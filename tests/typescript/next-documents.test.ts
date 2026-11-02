import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDocument, saveDocument } from "../../examples/apps/typescript/document-workspace/lib/documents";

describe("Folio first-run document storage", () => {
  let directory: string;
  let data: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "boundary-folio-seed-"));
    data = path.join(directory, "data");
    vi.stubEnv("BOUNDARY_FOLIO_DATA_DIR", data);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("reads a missing store without writing and persists the first save", async () => {
    expect(await readDocument("doc-1")).toMatchObject({ title: "Launch brief", revision: 1 });
    await expect(readFile(path.join(data, "documents.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await saveDocument({ id: "doc-1", title: "Our brief", body: "Our content", expectedRevision: 1 });
    expect(saved.revision).toBe(2);
    expect(JSON.parse(await readFile(path.join(data, "documents.json"), "utf8"))).toEqual([saved]);
    expect(await readDocument("doc-1")).toEqual(saved);
  });

  it("keeps existing document content and revision", async () => {
    vi.stubEnv("BOUNDARY_FOLIO_DATA_DIR", directory);
    const existing = { id: "doc-1", title: "Saved work", body: "Keep this", revision: 10 };
    await writeFile(path.join(directory, "documents.json"), JSON.stringify([existing]));
    expect(await readDocument("doc-1")).toEqual(existing);
    await expect(saveDocument({ ...existing, id: "doc-1", expectedRevision: 1 })).rejects.toMatchObject({ actualRevision: 10 });
    expect(await readDocument("doc-1")).toEqual(existing);
  });

  it("never replaces a malformed existing store with the seed", async () => {
    vi.stubEnv("BOUNDARY_FOLIO_DATA_DIR", directory);
    const target = path.join(directory, "documents.json");
    await writeFile(target, "malformed existing data");
    await expect(readDocument("doc-1")).rejects.toBeInstanceOf(SyntaxError);
    await expect(saveDocument({ id: "doc-1", title: "New", body: "New", expectedRevision: 1 })).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(target, "utf8")).toBe("malformed existing data");
  });
});
