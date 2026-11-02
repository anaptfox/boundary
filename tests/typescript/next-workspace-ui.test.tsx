// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveForm } from "../../examples/apps/typescript/document-workspace/app/save-form";
import { saveDocumentAction } from "../../examples/apps/typescript/document-workspace/app/actions";

vi.mock("../../examples/apps/typescript/document-workspace/app/actions", () => ({ saveDocumentAction: vi.fn() }));
vi.mock("../../examples/apps/typescript/document-workspace/app/publication-actions", () => ({ publicationAction: vi.fn() }));
vi.mock("../../examples/apps/typescript/document-workspace/app/assistant-panel", () => ({ AssistantPanel: () => null }));
vi.mock("../../examples/apps/typescript/document-workspace/app/activity-panel", () => ({ ActivityPanel: () => null }));
const document = { id: "doc-1", title: "Launch brief", body: "A clear starting point.", revision: 7 } as const;
const publicationView = { published: null, proposals: [] };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("Folio document workspace", () => {
  it("starts clean and keeps Bob read-only after editor hydration", async () => {
    render(<SaveForm publicationView={publicationView} document={document} canEdit={false} session="bob" />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Document body" }).getAttribute("contenteditable")).toBe("false"));
    expect(screen.getByRole("status").textContent).toContain("Persisted revision 7");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: /Read only/ }).hasAttribute("disabled")).toBe(true);
    expect(saveDocumentAction).not.toHaveBeenCalled();
  });
  it("keeps the base revision pinned while an unsaved title is edited", async () => {
    const view = render(<SaveForm publicationView={publicationView} document={document} canEdit session="alice" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Document title" }), { target: { value: "My unsaved title" } });
    expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
    view.rerender(<SaveForm publicationView={publicationView} document={{ ...document, revision: 8 }} canEdit session="alice" />);
    expect(view.container.querySelector<HTMLInputElement>('input[name="expectedRevision"]')?.value).toBe("7");
    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveProperty("value", "My unsaved title");
    expect(saveDocumentAction).not.toHaveBeenCalled();
  });
  it("retains uncertain outcomes and blocks another submission", async () => {
    vi.mocked(saveDocumentAction).mockResolvedValue({ status: "uncertain" });
    render(<SaveForm publicationView={publicationView} document={document} canEdit session="alice" />);
    fireEvent.click(screen.getByRole("button", { name: /Save revision/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Save outcome is unknown"));
    expect(screen.getByRole("button", { name: /Save revision/ }).hasAttribute("disabled")).toBe(true);
    expect(saveDocumentAction).toHaveBeenCalledTimes(1);
  });
  it("returns to clean when the author restores the original title", () => {
    render(<SaveForm publicationView={publicationView} document={document} canEdit session="alice" />);
    const title = screen.getByRole("textbox", { name: "Document title" });
    fireEvent.change(title, { target: { value: "Temporary draft" } });
    expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
    fireEvent.change(title, { target: { value: document.title } });
    expect(screen.getByRole("status").textContent).toContain("Persisted revision 7");
  });
  it("refreshes a clean editor with the externally persisted revision", async () => {
    const view = render(<SaveForm publicationView={publicationView} document={document} canEdit session="alice" />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Document body" }).getAttribute("contenteditable")).toBe("true"));
    view.rerender(<SaveForm publicationView={publicationView} document={{ ...document, title: "Agent improved title", body: "Agent updated body.", revision: 8 }} canEdit session="alice" />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Document title" })).toHaveProperty("value", "Agent improved title"));
    expect(screen.getByRole("textbox", { name: "Document body" }).textContent).toBe("Agent updated body.");
    expect(view.container.querySelector<HTMLInputElement>('input[name="expectedRevision"]')?.value).toBe("8");
    expect(screen.getByRole("status").textContent).toContain("Persisted revision 8");
  });
});
