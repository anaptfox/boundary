import { createProjectionHandlers } from "@foxworth/boundary/frameworks/next";
import { describe, expect, it, vi } from "vitest";

describe("@foxworth/boundary/frameworks/next", () => {
  it("projects one injected handler through every App Router method export", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ method: request.method }),
    );
    const methods = createProjectionHandlers(handler);

    expect(Object.isFrozen(methods)).toBe(true);
    expect(Object.keys(methods).sort()).toEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ]);
    expect(new Set(Object.values(methods))).toEqual(new Set([handler]));

    const response = await methods.POST(
      new Request("https://example.test/todos", { method: "POST" }),
    );
    await expect(response.json()).resolves.toEqual({ method: "POST" });
    expect(handler).toHaveBeenCalledOnce();
  });
});
