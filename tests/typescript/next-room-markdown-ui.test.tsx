// @vitest-environment happy-dom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantPanel } from "../../examples/apps/typescript/document-workspace/app/assistant-panel";
import { DraftContent } from "../../examples/apps/typescript/document-workspace/app/draft-content";
import { markdownDraft } from "../../examples/apps/typescript/document-workspace/lib/draft-markdown";
import { Markdown } from "../../examples/apps/typescript/document-workspace/app/markdown";
import { RoomDraft } from "../../examples/apps/typescript/document-workspace/app/room-draft";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../examples/apps/typescript/document-workspace/app/use-room", () => ({ useRoom: () => ({
  room: { version: 1, active: null, messages: [{ id: "reply", author: "editor", state: "complete", tools: [],
    text: "## A clearer brief\n\nA **bold** opening.\n\n- First step\n- Second step\n\n[unsafe](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/tracker.png)",
  }] }, connected: true, sending: false, resetting: false,
}) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders the actual room reply as safe Markdown, not literal markup", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [], defaultModel: null }))));
  const { container } = render(<AssistantPanel canEdit draftBusy={false} session="alice" onBusyChange={() => {}} />);
  expect(screen.getByRole("heading", { name: "A clearer brief" })).toBeDefined();
  expect(screen.getByText("bold").tagName).toBe("STRONG");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});

it("renders exactly the rich-text draft, while leaving old plain drafts literal", () => {
  const draft = markdownDraft(["## Audience", "", "The **internal** team.", "", "1. Review", "2. Approve"]);
  const view = render(<DraftContent {...draft} />);
  expect(screen.getByRole("heading", { name: "Audience" })).toBeDefined();
  expect(screen.getByText("internal").tagName).toBe("STRONG");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  view.rerender(<DraftContent body="## Audience" />);
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.getByText("## Audience")).toBeDefined();
});

it("shows GFM tables and read-only checklists in chat", () => {
  render(<Markdown>{"| Step | Owner |\n| --- | --- |\n| Draft | Editor |\n\n- [x] Read\n- [ ] Write"}</Markdown>);
  expect(screen.getByRole("table")).toBeDefined();
  expect(screen.getAllByRole("checkbox").every((input) => input.hasAttribute("disabled"))).toBe(true);
});

it("expands and compacts the exact unsaved draft without changing the review controls", async () => {
  const draft = { id: "draft-one", title: "Review this", expectedRevision: 4, ...markdownDraft(["## Audience", "", "The **internal** team."]) };
  render(<RoomDraft draft={draft} />);
  const toggle = screen.getByRole("button", { name: "Read full draft" });
  toggle.focus();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
  expect(screen.getByRole("heading", { name: "Audience" })).toBeDefined();
  expect(screen.getByText("internal").tagName).toBe("STRONG");
  expect(document.activeElement).toBe(toggle);
  expect(screen.getByText("Formatted draft · not saved")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Compact preview" }));
  await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  expect(screen.getByRole("heading", { name: "Audience" })).toBeDefined();
});
