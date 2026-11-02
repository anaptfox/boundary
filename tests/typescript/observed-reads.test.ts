import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindProjection, compileInteractions, defineInteraction, directRealizationIds,
  implementInteractions, installInteractions, projectAllDirect,
} from "@foxworth/boundary";
import { canonicalJson, normalizeJson, portableSchema, type JsonSchema, type JsonValue } from "@foxworth/boundary/program";
import {
  observedRead, type ObservationSource, type ObservationValidation,
  type ObservedReadDiagnostic, type ObservationView,
} from "@foxworth/boundary/observations";
import { createTodoHost } from "../../examples/apps/typescript/todo-multisurface/host";
import { todoSnapshots, type TodoQuery } from "../../examples/apps/typescript/todo-multisurface/observations";
import type { Todo } from "../../examples/apps/typescript/todo-multisurface/interactions";

type Context = { kind: "screen"; actorId: string; allowed: boolean };
type Source = ObservationSource<Context, JsonValue, JsonValue, JsonValue, JsonValue>;
type View = ObservationView<JsonValue, JsonValue, JsonValue, JsonValue>;
type World = { points: Record<string, JsonValue>; rows: readonly Todo[] };
const context: Context = { kind: "screen", actorId: "one", allowed: true };
const vector = JSON.parse(readFileSync(new URL("../conformance/v1/observed-reads.json", import.meta.url), "utf8")) as {
  points: { name: string; key: string; source: Record<string, JsonValue>; target: Record<string, JsonValue>; expected: string }[];
  queries: { name: string; query: TodoQuery; source: Todo[]; target: Todo[]; expected: string }[];
};

function source(current: () => World, validation?: () => ObservationValidation | "throw"): Source {
  return {
    async withSnapshot(ctx, scope, run) {
      const world = normalizeJson(current()) as unknown as World;
      const point = (key: JsonValue) => {
        const name = String(key);
        return Object.hasOwn(world.points, name)
          ? { kind: "present" as const, value: world.points[name]!, token: canonicalJson({ present: true, value: world.points[name]! }) }
          : { kind: "absent" as const, token: canonicalJson({ present: false }) };
      };
      return todoSnapshots({ list: () => world.rows }).withSnapshot(ctx, scope, async rows => run({
        read: point,
        query: query => rows.query(query as TodoQuery),
        async validate(observation) {
          const override = validation?.();
          if (override === "throw") throw new Error("validation unavailable");
          if (override) return override;
          const current = observation.kind === "point" ? point(observation.key) : await rows.query(observation.query as TodoQuery);
          return current.token === observation.token ? "matching" : "changed";
        },
      }));
    },
  };
}

async function host(snapshots: Source, evaluate: (input: JsonValue, view: View) => Promise<JsonValue>, options: {
  reuse?: "off" | "validated"; maxEntries?: number; output?: JsonSchema;
  useDefaultReuse?: boolean;
  diagnostic?: (event: ObservedReadDiagnostic) => void;
} = {}) {
  const diagnostics: ObservedReadDiagnostic[] = [];
  let authorizations = 0;
  const definitions = { read: defineInteraction({ id: "observed.read", input: portableSchema<JsonValue>({}),
    output: portableSchema<JsonValue>(options.output ?? {}), reads: ["world"], changes: [] }) };
  const compiled = await compileInteractions(definitions);
  const projection = await projectAllDirect(compiled);
  const implementations = implementInteractions<typeof definitions, Context>(definitions, {
    read: observedRead(definitions.read, {
      snapshots,
      scope: ctx => ({ actorId: ctx.actorId }),
      authorize(_input, ctx) { authorizations++; if (!ctx.allowed) throw new Error("not allowed"); },
      evaluate,
      reuse: options.useDefaultReuse ? undefined : options.reuse ?? "validated",
      maxEntries: options.maxEntries,
      diagnostic(event) { diagnostics.push(event); options.diagnostic?.(event); },
    }),
  });
  const install = async (revision: string) => {
    const installed = await installInteractions(compiled, { installationId: `observed:${revision}`, implementations,
      realizationIds: directRealizationIds(compiled, revision) });
    const bound = await bindProjection(projection, installed.installation, { admit: () => ({ decision: "allow" }) });
    if (bound.status !== "bound") throw new Error("expected binding");
    return { ...installed, call: (input: JsonValue, ctx: Context = context) => bound.binding.connect().call(projection.handles.read, input, ctx) };
  };
  return { ...(await install("one")), install, diagnostics, get authorizations() { return authorizations; } };
}

describe("observed reads", () => {
  for (const law of vector.points) it(`shared point: ${law.name}`, async () => {
    let points = law.source;
    const instance = await host(source(() => ({ points, rows: [] })), (input, view) => view.read(input));
    await instance.call(law.key);
    points = law.target;
    const output = await instance.call(law.key);
    expect(instance.diagnostics.at(-1)?.reason).toBe(law.expected);
    expect(instance.diagnostics.at(-1)?.reused).toBe(law.expected === "matching");
    expect(output).toEqual(Object.hasOwn(points, law.key) ? { kind: "present", value: points[law.key] } : { kind: "absent" });
  });

  for (const law of vector.queries) it(`shared query: ${law.name}`, async () => {
    let rows = law.source;
    const instance = await host(source(() => ({ points: {}, rows })), (query, view) => view.query(query));
    await instance.call(law.query);
    rows = law.target;
    const output = await instance.call(law.query);
    expect(instance.diagnostics.at(-1)?.reason).toBe(law.expected);
    const fresh = await todoSnapshots({ list: () => rows }).withSnapshot(context, null, async snapshot => (await snapshot.query(law.query)).value);
    expect(output).toEqual(fresh);
  });

  it("records selectors and regenerates the actual dependency trace", async () => {
    let points: Record<string, JsonValue> = { selector: "a", a: 1, b: 2 };
    const instance = await host(source(() => ({ points, rows: [] })), async (_input, view) => {
      const selector = await view.read("selector");
      return selector.kind === "present" ? view.read(selector.value) : null;
    });
    expect(await instance.call(null)).toEqual({ kind: "present", value: 1 });
    points = { ...points, selector: "b" };
    expect(await instance.call(null)).toEqual({ kind: "present", value: 2 });
    points = { ...points, a: 99 };
    expect(await instance.call(null)).toEqual({ kind: "present", value: 2 });
    expect(instance.diagnostics.at(-1)?.reused).toBe(true);
  });

  it("isolates input, visibility scope, installation and realization; checks fresh authorization", async () => {
    let evaluations = 0;
    const instance = await host(source(() => ({ points: { a: 1, b: 2 }, rows: [] })), async (input, view) => {
      evaluations++; return view.read(input);
    });
    await instance.call("a"); await instance.call("a");
    await instance.call("b");
    await instance.call("a", { ...context, actorId: "two" });
    const replacement = await instance.install("two");
    await replacement.call("a");
    expect(evaluations).toBe(4);
    expect(instance.authorizations).toBe(5);
    await expect(instance.call("a", { ...context, allowed: false })).rejects.toThrow();
    expect(evaluations).toBe(4);
    instance.controller.revoke();
    await expect(instance.call("a")).rejects.toThrow();
    await replacement.call("a");
    expect(evaluations).toBe(4);
  });

  it("owns retained outputs and snapshots source values", async () => {
    const points: Record<string, JsonValue> = { a: { count: 1 } };
    const instance = await host(source(() => ({ points, rows: [] })), async (input, view) => {
      const result = await view.read(input);
      return result.kind === "present" ? result.value : null;
    });
    const output = await instance.call("a") as { count: number };
    expect(() => { output.count = 999; }).toThrow(TypeError);
    expect(await instance.call("a")).toEqual({ count: 1 });
    (points.a as { count: number }).count = 2;
    expect(await instance.call("a")).toEqual({ count: 2 });
  });

  it.each(["unavailable", "throw"] as const)("reevaluates when validation is %s", async behavior => {
    let evaluations = 0;
    const instance = await host(source(() => ({ points: { a: 1 }, rows: [] }), () => behavior), async (input, view) => {
      evaluations++; return view.read(input);
    });
    await instance.call("a"); await instance.call("a");
    expect(evaluations).toBe(2);
    expect(instance.diagnostics.at(-1)?.reason).toBe("unavailable");
  });

  it("never retains exceptions or invalid output", async () => {
    let evaluations = 0;
    const instance = await host(source(() => ({ points: {}, rows: [] })), async () => {
      evaluations++; return evaluations <= 2 ? "invalid" : 1;
    }, { output: { type: "number" } });
    await expect(instance.call(null)).rejects.toThrow();
    await expect(instance.call(null)).rejects.toThrow();
    expect(await instance.call(null)).toBe(1);
    expect(await instance.call(null)).toBe(1);
    expect(evaluations).toBe(3);
    let attempts = 0;
    const throwing = await host(source(() => ({ points: {}, rows: [] })), async () => { attempts++; throw new Error("failed"); });
    await expect(throwing.call(null)).rejects.toThrow(); await expect(throwing.call(null)).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it("supports default-off and bounded FIFO retention", async () => {
    const snapshots = source(() => ({ points: { a: 1, b: 2 }, rows: [] }));
    const off = await host(snapshots, (input, view) => view.read(input), { useDefaultReuse: true });
    await off.call("a"); await off.call("a");
    expect(off.diagnostics.map(event => event.reason)).toEqual(["reuse-off", "reuse-off"]);
    const zero = await host(snapshots, (input, view) => view.read(input), { maxEntries: 0 });
    await zero.call("a"); await zero.call("a");
    expect(zero.diagnostics.map(event => event.reason)).toEqual(["reuse-off", "reuse-off"]);
    const bounded = await host(snapshots, (input, view) => view.read(input), { maxEntries: 1 });
    await bounded.call("a"); await bounded.call("b"); await bounded.call("a");
    expect(bounded.diagnostics.every(event => !event.reused)).toBe(true);
  });

  it("diagnostic failures cannot change successful output", async () => {
    const instance = await host(source(() => ({ points: { a: 1 }, rows: [] })), (input, view) => view.read(input), {
      diagnostic() { throw new Error("report unavailable"); },
    });
    expect(await instance.call("a")).toEqual({ kind: "present", value: 1 });
    expect(await instance.call("a")).toEqual({ kind: "present", value: 1 });
  });

  it("does not retain output if the snapshot boundary fails after evaluation", async () => {
    let fail = true;
    let evaluations = 0;
    const underlying = source(() => ({ points: {}, rows: [] }));
    const snapshots: Source = { async withSnapshot(ctx, scope, run) {
      const result = await underlying.withSnapshot(ctx, scope, run);
      if (fail) throw new Error("snapshot completion unavailable");
      return result;
    } };
    const instance = await host(snapshots, async () => ++evaluations);
    await expect(instance.call(null)).rejects.toThrow();
    fail = false;
    expect(await instance.call(null)).toBe(2);
    expect(await instance.call(null)).toBe(2);
    expect(evaluations).toBe(2);
  });

  it("rejects a source that returns before evaluation settles", async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const underlying = source(() => ({ points: { a: 1 }, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, async snapshot => {
        void run(snapshot);
        return 1 as never;
      });
    } };
    const instance = await host(snapshots, async (_input, view) => {
      await deferred;
      return view.read("a");
    });
    await expect(instance.call(null)).rejects.toThrow();
    release();
    await deferred;
    await Promise.resolve();
  });

  it("rejects substituted callback results even when reuse is off", async () => {
    const underlying = source(() => ({ points: {}, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, async snapshot => { await run(snapshot); return 2 as never; });
    } };
    const instance = await host(snapshots, async () => 1, { reuse: "off" });
    await expect(instance.call(null)).rejects.toThrow();
  });

  it("rejects a source that swallows evaluation failure", async () => {
    const underlying = source(() => ({ points: {}, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, run).catch(() => 1 as never);
    } };
    const instance = await host(snapshots, async () => { throw new Error("evaluation failed"); });
    await expect(instance.call(null)).rejects.toThrow();
  });

  it("rejects duplicated callbacks even if the source suppresses the second failure", async () => {
    const underlying = source(() => ({ points: {}, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, async snapshot => {
        const result = await run(snapshot);
        try { await run(snapshot); } catch { /* Invalid source ignores the protocol fault. */ }
        return result;
      });
    } };
    const instance = await host(snapshots, async () => 1);
    await expect(instance.call(null)).rejects.toThrow();
  });

  it("does not retain a result with outstanding observations", async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const underlying = source(() => ({ points: { a: 1 }, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, snapshot => run({ ...snapshot,
        async read(key) { await deferred; return snapshot.read(key); },
      }));
    } };
    let evaluations = 0;
    const instance = await host(snapshots, async (_input, view) => {
      evaluations++;
      void view.read("a").catch(() => {});
      return 1;
    });
    await instance.call(null); await instance.call(null);
    expect(evaluations).toBe(2);
    release();
    await deferred;
    await Promise.resolve();
  });

  it("closes escaped views and never retains failed reads caught by an evaluator", async () => {
    let escaped: View | undefined;
    let evaluations = 0;
    const underlying = source(() => ({ points: {}, rows: [] }));
    const snapshots: Source = { withSnapshot(ctx, scope, run) {
      return underlying.withSnapshot(ctx, scope, snapshot => run({ ...snapshot,
        read() { throw new Error("point unavailable"); },
      }));
    } };
    const instance = await host(snapshots, async (_input, view) => {
      escaped = view; evaluations++;
      try { await view.read("a"); } catch { /* Domain fallback must not become retained evidence. */ }
      return 1;
    });
    await instance.call(null); await instance.call(null);
    expect(evaluations).toBe(2);
    await expect(escaped!.read("a")).rejects.toThrow("closed");
  });

  it("rejects changing and forged definitions and invalid retention options", () => {
    const changing = defineInteraction({ id: "change", output: portableSchema<number>({ type: "number" }), changes: ["world"] });
    const options = { snapshots: source(() => ({ points: {}, rows: [] })), scope: () => null,
      authorize() {}, evaluate: () => 1 };
    expect(() => observedRead(changing, options)).toThrow("changing");
    expect(() => observedRead({ ...changing }, options)).toThrow("authentic");
    const read = defineInteraction({ id: "read", output: portableSchema<number>({ type: "number" }) });
    expect(() => observedRead(read, { ...options, maxEntries: -1 })).toThrow("retention");
  });

  it("generated query reuse agrees with a fresh oracle", async () => {
    let rows: Todo[] = [];
    const instance = await host(source(() => ({ points: {}, rows })), (query, view) => view.query(query));
    const queries: TodoQuery[] = [null, false, true].flatMap(completed => [null, 1].map(limit => ({ completed, order: "id-asc", offset: 0, limit } as const)));
    for (let world = 0; world < 32; world++) {
      rows = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, title: `v${(world + i) % 3}`, completed: Boolean(world & (1 << i)) }));
      for (const query of queries) {
        const selected: Todo[] = [];
        for (const row of rows) if (query.completed === null || query.completed === row.completed) selected.push(row);
        const expected = query.limit === null ? selected : selected.slice(0, query.limit);
        expect(await instance.call(query)).toEqual(expected);
        expect(await instance.call(query)).toEqual(expected);
      }
    }
  });

  it("fresh oracle exposes a deliberately incomplete query validator", async () => {
    let rows: Todo[] = [];
    const instance = await host(source(() => ({ points: {}, rows }), () => "matching"), (query, view) => view.query(query));
    const query: TodoQuery = { completed: false, order: "stored", offset: 0, limit: null };
    expect(await instance.call(query)).toEqual([]);
    rows = [{ id: 1, title: "phantom", completed: false }];
    const reused = await instance.call(query);
    expect(reused).not.toEqual(rows); // Negative control: a lying host adapter violates the contract.
  });

  it("Todo pilot keeps admitted calls, reuses reads, and invalidates query evidence", async () => {
    const todo = await createTodoHost();
    const first = await todo.screenCaller.call(todo.screen.handles.list, todo.screenContext);
    expect(await todo.screenCaller.call(todo.screen.handles.list, todo.screenContext)).toEqual(first);
    expect(todo.readStats).toEqual({ evaluations: 1, reuses: 1, validations: 1 });
    await todo.screenCaller.call(todo.screen.handles.create, { title: "New matching row" }, todo.screenContext);
    expect(await todo.screenCaller.call(todo.screen.handles.list, todo.screenContext)).toHaveLength(first.length + 1);
    expect(todo.readStats.evaluations).toBe(2);
    await expect(todo.screenCaller.call(todo.screen.handles.list, todo.agentContext)).rejects.toThrow();
    expect(todo.readStats.evaluations).toBe(2);
  });
});
