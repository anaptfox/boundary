import { InteractionFault } from "@foxworth/boundary";
import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "folio-result-test-"));
vi.stubEnv("BOUNDARY_FOLIO_PUBLICATIONS", join(directory, "publication.sqlite"));
vi.stubEnv("BOUNDARY_FOLIO_SOURCE_ROOT", join(process.cwd(), "examples/apps/typescript/document-workspace"));
const { projection, publications } = await import("../../examples/apps/typescript/document-workspace/lib/boundary");
afterAll(() => { publications.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
import { saveFailure } from "../../examples/apps/typescript/document-workspace/lib/save-result";

describe("Next example save outcomes", () => {
  it("keeps a possibly-started save uncertain", () => {
    expect(saveFailure(new InteractionFault("realization-failed", "unknown", "lost response"), projection.handles.save))
      .toEqual({ status: "uncertain" });
  });
  it("shows rejection only for a known not-started invocation", () => {
    expect(saveFailure(new InteractionFault("denied", "not-started", "denied"), projection.handles.save))
      .toEqual({ status: "rejected" });
  });
  it("does not infer non-execution from an arbitrary invocation error", () => {
    expect(saveFailure(new Error("unclassified failure"), projection.handles.save))
      .toEqual({ status: "uncertain" });
  });
});
