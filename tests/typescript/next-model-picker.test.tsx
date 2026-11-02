// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../examples/apps/typescript/document-workspace/app/model-picker";
afterEach(cleanup);
describe("Folio searchable local model menu", () => {
  it("filters the catalog and selects a model through the keyboard", async () => {
    const changed = vi.fn();
    render(<ModelPicker models={["llama-local", "qwen-local"]} value="qwen-local" disabled={false} onChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose local model" }));
    const input = await screen.findByLabelText("Search local models");
    fireEvent.change(input, { target: { value: "llama" } });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /qwen-local/u })).toBeNull());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(changed).toHaveBeenCalledWith("llama-local"));
  });
  it("disables the unavailable model catalog", () => {
    render(<ModelPicker models={[]} value="" disabled onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Choose local model" }).hasAttribute("disabled")).toBe(true);
  });
});
