import { AdapterError } from "@foxworth/boundary/remote";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { InteractionFault } from "@foxworth/boundary";
import { createCaller } from "@foxworth/boundary/pipeline";
import { describe, expect, it } from "vitest";
import { createAdapterFixture, type AdapterContext } from "./helpers/adapter";

async function boundFixture() {
  const fixture = await createAdapterFixture();
  const { caller } = await fixture.connect({ call: ["list", "create", "explode"], propose: ["create"] });
  return { fixture, caller };
}

describe("@foxworth/boundary/frameworks/next native server caller", () => {
  it("derives isolated context per overlapping direct server read without HTTP", async () => {
    const { fixture, caller } = await boundFixture();
    const contexts: AdapterContext[] = [
      { role: "owner", marker: { session: "a" } },
      { role: "viewer", marker: { session: "b" } },
    ];
    const next = createNextServerCaller({
      caller,
      context: async () => contexts.shift()!,
    });

    const [allowed, denied] = await Promise.allSettled([
      next.read.list(),
      next.read.list(),
    ]);

    expect(allowed.status).toBe("fulfilled");
    expect(denied).toMatchObject({ status: "rejected", reason: { cause: "denied", certainty: "not-started" } });
    expect(fixture.contexts.map((context) => context.marker)).toEqual([{ session: "a" }]);
  });

  it("runs host cache work only after a completed action and never retries a failed one", async () => {
    const { fixture, caller } = await boundFixture();
    const completed: string[] = [];
    const cacheErrors: unknown[] = [];
    const next = createNextServerCaller({
      caller,
      context: () => ({ role: "owner" as const, marker: { tenant: "a" } }),
      afterAction: async ({ interactionId, context }) => {
        completed.push(`${interactionId}:${(context.marker as { tenant: string }).tenant}`);
        throw new Error("cache unavailable");
      },
      onCacheError: (error) => cacheErrors.push(error),
    });

    await expect(next.action.create({ title: "one" }))
      .resolves.toEqual({ id: 1, title: "one" });
    await expect(next.action.explode()).rejects.toBeInstanceOf(InteractionFault);

    expect(fixture.rows).toEqual([{ id: 1, title: "one" }]);
    expect(completed).toEqual(["todos.create:a"]);
    expect(cacheErrors).toHaveLength(1);
  });

  it("rejects a declared mutation from a read before context or dispatch", async () => {
    const { fixture, caller } = await boundFixture();
    let contextCalls = 0;
    const next = createNextServerCaller({
      caller,
      context: () => {
        contextCalls += 1;
        return { role: "owner" as const };
      },
    });

    await expect(next.read.create({ title: "must not run" }))
      .rejects.toMatchObject({ code: "INVALID_DECLARATION" } satisfies Partial<AdapterError>);
    expect(contextCalls).toBe(0);
    expect(fixture.rows).toEqual([]);
    expect(fixture.contexts).toEqual([]);
  });

  it("preserves declared action errors and proposal semantics without cache refresh", async () => {
    const { caller } = await boundFixture();
    const completed: string[] = [];
    const next = createNextServerCaller({
      caller,
      context: () => ({ role: "owner" as const }),
      afterAction: ({ interactionId }) => { completed.push(interactionId); },
    });

    await expect(next.action.create({ title: "duplicate" }))
      .rejects.toMatchObject({ code: "duplicate", details: { title: "duplicate" } });
    await expect(next.action.propose.create({ title: "draft" }))
      .resolves.toEqual({ title: "draft" });
    expect(completed).toEqual([]);
  });

  it("reports a revoked pinned Binding as stale/not-started and does not enter the host", async () => {
    const fixture = await createAdapterFixture();
    const { caller, binding, projection } = await fixture.connect({ call: ["list"] });
    const bound = await (async () => {
      const result = await import("@foxworth/boundary/pipeline").then(({ bindSurface }) =>
        bindSurface(projection, fixture.installation, { admit: () => ({ decision: "allow" }) }),
      );
      if (result.status !== "bound") throw new Error("fixture did not bind");
      return result;
    })();
    expect(bound.binding.manifest.bindingDigest).toBe(binding.manifest.bindingDigest);
    const next = createNextServerCaller({ caller: createCaller(bound.binding) as unknown as typeof caller, context: () => ({ role: "owner" as const }) });
    bound.controller.revoke();

    await expect(next.read.list())
      .rejects.toMatchObject({ cause: "revoked", certainty: "not-started" });
    expect(fixture.contexts).toEqual([]);
  });
});
