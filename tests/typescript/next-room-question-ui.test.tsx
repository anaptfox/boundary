// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomQuestion } from "../../examples/apps/typescript/document-workspace/app/room-question";
import type { RoomInput, RoomQuestion as Question } from "../../examples/apps/typescript/document-workspace/lib/room-types";

const question: Question = { id: "question", kind: "choice", prompt: "Who is this for?", options: ["Customers", "Internal team"], state: "pending", resume: "scout", work: { id: "work", goal: "Draft a brief", owner: "alice", model: "local", steps: 1 } };
afterEach(cleanup);
describe("inline human questions", () => {
  it("binds a choice to its question and preserves the request id after ambiguous acceptance", async () => {
    const send = vi.fn<(input: RoomInput) => Promise<boolean>>().mockResolvedValue(false);
    render(<RoomQuestion question={question} disabled={false} canApply session="alice" send={send} />);
    const button = screen.getByRole("button", { name: "Customers" });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(send.mock.calls[0]?.[0].answer).toEqual({ questionId: "question", value: "Customers" });
    expect(send.mock.calls[0]?.[0].allowSave).toBe(false);
  });
  it("accepts free direction alongside choices", async () => {
    const send = vi.fn().mockResolvedValue(true);
    render(<RoomQuestion question={question} disabled={false} canApply session="alice" send={send} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Early customers in small businesses" } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]?.[0].answer.value).toBe("Early customers in small businesses");
  });
  it("does not offer a free-text approval or enable Apply over a dirty editor", () => {
    const send = vi.fn();
    render(<RoomQuestion question={{ ...question, kind: "approval", options: ["Apply", "Keep as draft"] }} disabled={false} canApply={false} session="alice" send={send} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Keep as draft" }).hasAttribute("disabled")).toBe(false);
  });
  it("shows a waiting question to the other human without accepting their response", () => {
    const send = vi.fn();
    render(<RoomQuestion question={question} disabled={false} canApply={false} session="bob" send={send} />);
    expect(screen.getByText("WAITING FOR ALICE")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Customers" }));
    expect(send).not.toHaveBeenCalled();
  });
  it("renders the answer or cancelled state without active controls", () => {
    const view = render(<RoomQuestion question={{ ...question, state: "answered", answer: "Customers" }} disabled={false} canApply session="alice" send={vi.fn()} />);
    expect(screen.getByText("Customers")).toBeDefined(); expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<RoomQuestion question={{ ...question, state: "cancelled" }} disabled={false} canApply session="alice" send={vi.fn()} />);
    expect(screen.getByText("CANCELLED")).toBeDefined(); expect(screen.queryByRole("button")).toBeNull();
  });
});
