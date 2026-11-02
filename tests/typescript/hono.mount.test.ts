import { mountProjection } from "@foxworth/boundary/frameworks/hono";
import { describe, expect, it, vi } from "vitest";

describe("@foxworth/boundary/frameworks/hono", () => {
  it("adapts an injected handler without choosing application routes", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ pathname: new URL(request.url).pathname }),
    );
    const middleware = mountProjection(handler);
    const request = new Request("https://example.test/domain/todos");

    const response = await middleware(
      { req: { raw: request } } as never,
      async () => undefined,
    );

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected response");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pathname: "/domain/todos" });
    expect(handler).toHaveBeenCalledOnce();
  });
});
