// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicationPanel } from "../../examples/apps/typescript/document-workspace/app/publication-panel";
import type { PublicationView } from "../../examples/apps/typescript/document-workspace/lib/publication";
vi.mock(
  "../../examples/apps/typescript/document-workspace/app/publication-actions",
  () => ({ publicationAction: vi.fn() }),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const proposal = {
  id: "proposal-one",
  digest: "sha256:exact",
  revision: 7,
  title: "Reviewed title",
  body: "Exact reviewed body",
  requestedBy: "folio-editor:for:alice",
  state: "needs-review",
};
const view: PublicationView = { published: null, proposals: [proposal] };
describe("Folio exact publication review", () => {
  it("labels disconnected status and reconnects by reading without replaying an action", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json(view));
    vi.stubGlobal("fetch", fetchStatus);
    render(
      <PublicationPanel
        revision={7}
        canEdit
        draftBusy={false}
        initialView={view}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole("status").textContent).toContain(
      "last observed status",
    );
    expect(screen.getByText("Exact reviewed body")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchStatus.mock.calls) {
      expect(url).toBe("/api/publication-status");
      expect(options.method).toBeUndefined();
    }
  });
  it("shows the exact saved preview and binds approval to its ID and digest", () => {
    const result = render(
      <PublicationPanel
        revision={7}
        canEdit
        draftBusy={false}
        initialView={view}
      />,
    );
    expect(screen.getByText("Exact reviewed body")).toBeTruthy();
    expect(
      result.container.querySelector<HTMLInputElement>('input[name="proposal"]')
        ?.value,
    ).toBe(proposal.id);
    expect(
      result.container.querySelector<HTMLInputElement>('input[name="digest"]')
        ?.value,
    ).toBe(proposal.digest);
    expect(
      screen.getByRole("button", { name: "Approve & publish exact revision" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it.each([[false, false, 7], [true, true, 7], [true, false, 8]] as const)(
    "blocks Bob, unsaved work, and a stale revision",
    (canEdit, draftBusy, revision) => {
      render(
        <PublicationPanel
          revision={revision}
          canEdit={canEdit}
          draftBusy={draftBusy}
          initialView={view}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Approve & publish exact revision" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );
  it("offers reconciliation instead of another execution for an uncertain effect", () => {
    render(
      <PublicationPanel
        revision={7}
        canEdit
        draftBusy={false}
        initialView={{
          ...view,
          proposals: [{ ...proposal, state: "uncertain" }],
        }}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Approve & publish exact revision",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Reconcile result" }))
      .toBeTruthy();
  });
});
