import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Import before Folio's server modules. Never open the author's demo database.
const directory = mkdtempSync(join(tmpdir(), "boundary-folio-test-"));
const data = join(directory, "data");
mkdirSync(data);
writeFileSync(
  join(data, "documents.json"),
  JSON.stringify([{
    id: "doc-1",
    title: "Test brief",
    body: "Isolated test document",
    revision: 1,
  }]),
);
process.env.BOUNDARY_FOLIO_MCP_RESOURCE = "https://folio.test/api/mcp";
process.env.BOUNDARY_FOLIO_SOURCE_ROOT = join(process.cwd(), "examples/apps/typescript/document-workspace");
process.env.BOUNDARY_FOLIO_PUBLICATIONS = join(data, "publications.sqlite");
process.env.BOUNDARY_FOLIO_DATA_DIR = data;
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
