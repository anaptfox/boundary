import { AdapterError } from "@foxworth/boundary/client";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { projectInteractions } from "@foxworth/boundary";
import { InteractionFault } from "@foxworth/boundary";
import { describe, expect, it } from "vitest";
import { createAdapterFixture, type AdapterContext } from "./helpers/adapter";

async function boundFixture() {
  const fixture = await createAdapterFixture();
  const projection = projectInteractions(fixture.compiled, {
    list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    create: { interaction: fixture.compiled.handles.create, modes: ["direct", "request"] },
    explode: { interaction: fixture.compiled.handles.explode, modes: ["direct"] },
  });
  return { fixture, projection, binding: await fixture.bind(projection) };
}

describe("@foxworth/boundary/frameworks/next native server caller", () => {
  it("derives isolated context per overlapping direct server read without HTTP", async () => {
    const { fixture, projection, binding } = await boundFixture();
    const contexts: AdapterContext[] = [
      { role: "owner", marker: { session: "a" } },
      { role: "viewer", marker: { session: "b" } },
    ];
    const next = createNextServerCaller({
      binding,
      context: async () => contexts.shift()!,
    });

    const [allowed, denied] = await Promise.allSettled([
      next.read.call(projection.handles.list),
      next.read.call(projection.handles.list),
    ]);

    expect(allowed.status).toBe("fulfilled");
    expect(denied).toMatchObject({ status: "rejected", reason: { cause: "denied", certainty: "not-started" } });
    expect(fixture.contexts.map((context) => context.marker)).toEqual([{ session: "a" }]);
  });

  it("runs host cache work only after a completed action and never retries a failed one", async () => {
    const { fixture, projection, binding } = await boundFixture();
    const completed: string[] = [];
    const cacheErrors: unknown[] = [];
    const next = createNextServerCaller({
      binding,
      context: () => ({ role: "owner" as const, marker: { tenant: "a" } }),
      afterAction: async ({ interactionId, context }) => {
        completed.push(`${interactionId}:${(context.marker as { tenant: string }).tenant}`);
        throw new Error("cache unavailable");
      },
      onCacheError: (error) => cacheErrors.push(error),
    });

    await expect(next.action.call(projection.handles.create, { title: "one" }))
      .resolves.toEqual({ id: 1, title: "one" });
    await expect(next.action.call(projection.handles.explode)).rejects.toBeInstanceOf(InteractionFault);

    expect(fixture.rows).toEqual([{ id: 1, title: "one" }]);
    expect(completed).toEqual(["todos.create:a"]);
    expect(cacheErrors).toHaveLength(1);
  });

  it("rejects a declared mutation from read.call before context or dispatch", async () => {
    const { fixture, projection, binding } = await boundFixture();
    let contextCalls = 0;
    const next = createNextServerCaller({
      binding,
      context: () => {
        contextCalls += 1;
        return { role: "owner" as const };
      },
    });

    await expect(next.read.call(projection.handles.create, { title: "must not run" }))
      .rejects.toMatchObject({ code: "INVALID_DECLARATION" } satisfies Partial<AdapterError>);
    expect(contextCalls).toBe(0);
    expect(fixture.rows).toEqual([]);
    expect(fixture.contexts).toEqual([]);
  });

  it("preserves declared action errors and proposal semantics without cache refresh", async () => {
    const { projection, binding } = await boundFixture();
    const completed: string[] = [];
    const next = createNextServerCaller({
      binding,
      context: () => ({ role: "owner" as const }),
      afterAction: ({ interactionId }) => { completed.push(interactionId); },
    });

    await expect(next.action.call(projection.handles.create, { title: "duplicate" }))
      .rejects.toMatchObject({ code: "duplicate", details: { title: "duplicate" } });
    await expect(next.action.request(projection.handles.create, { title: "draft" }))
      .resolves.toEqual({ title: "draft" });
    expect(completed).toEqual([]);
  });

  it("reports a revoked pinned Binding as stale/not-started and does not enter the host", async () => {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    });
    const bound = await (async () => {
      const result = await import("@foxworth/boundary").then(({ bindProjection }) =>
        bindProjection(projection, fixture.installation, { admit: () => ({ decision: "allow" }) }),
      );
      if (result.status !== "bound") throw new Error("fixture did not bind");
      return result;
    })();
    const next = createNextServerCaller({ binding: bound.binding, context: () => ({ role: "owner" as const }) });
    bound.controller.revoke();

    await expect(next.read.call(projection.handles.list))
      .rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    expect(fixture.contexts).toEqual([]);
  });
});
