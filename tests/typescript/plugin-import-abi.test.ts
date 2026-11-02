// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HostImports, createPluginExecutor, loadPlugin } from "../../packages/guests/plugin/index";

type Vector = {
  interface: string;
  provided: string[];
  fixtures: Record<string, string>;
  cases: { name: string; fixture: string; invoke: boolean; certainty: string; hostCalls: number }[];
  hostcallCopyBudget: {
    default: number;
    cases: {
      name: string; fixture: string; limit: number; replyKind: "ok" | "err"; reply: string;
      lifetime: "per-call" | "persistent"; calls: number; outcomes: string[]; hostCalls: number;
    }[];
  };
};
const vector = JSON.parse(
  readFileSync(new URL("../conformance/v1/plugin-import-abi.json", import.meta.url), "utf8"),
) as Vector;
const bytesOf = (fixture: string) =>
  new Uint8Array(readFileSync(new URL(`../../${vector.fixtures[fixture]}`, import.meta.url)));

const executors: ReturnType<typeof createPluginExecutor>[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("exact host-import signature law", () => {
  for (const testCase of vector.cases) {
    it(testCase.name, async () => {
      const executor = createPluginExecutor();
      executors.push(executor);
      let count = 0;
      const loaded = await loadPlugin({
        executor,
        bytes: bytesOf(testCase.fixture),
        imports: vector.provided.reduce((acc, name) => acc.provide(name), new HostImports(vector.interface)),
        witDigest: "world",
        host: { images: () => { count++; return { tag: "ok", val: "{}" }; } },
      });
      let actual: string = loaded.status === "fault" ? loaded.certainty : loaded.status;
      if (loaded.status === "ready") {
        expect(testCase.invoke, "admitted").toBe(true);
        const outcome = await loaded.instance.call("run", "");
        actual = outcome.status === "fault" ? outcome.certainty : "completed";
        if (testCase.certainty === "completed") expect(outcome).toEqual({ status: "returned", payload: "{}" });
        await loaded.instance.close();
      }
      expect(count, `${testCase.name}: host entries (${actual})`).toBe(testCase.hostCalls);
      expect(actual).toBe(testCase.certainty);
    });
  }
});

describe("host-call copy budget law", () => {
  it("shares one default with Rust", () => {
    expect(createPluginExecutor().limits.hostcallCopyBytes).toBe(vector.hostcallCopyBudget.default);
  });
  for (const testCase of vector.hostcallCopyBudget.cases) {
    it(testCase.name, async () => {
      const executor = createPluginExecutor({ hostcallCopyBytes: testCase.limit });
      executors.push(executor);
      let count = 0;
      const loaded = await loadPlugin({
        executor,
        bytes: bytesOf(testCase.fixture),
        imports: vector.provided.reduce((acc, name) => acc.provide(name), new HostImports(vector.interface)),
        witDigest: "world",
        lifetime: testCase.lifetime,
        host: {
          images: () => {
            count++;
            return { tag: testCase.replyKind, val: testCase.reply };
          },
        },
      });
      const token = (outcome: { status: string; certainty?: string }) =>
        outcome.status === "fault" ? outcome.certainty
          : outcome.status === "returned" ? "completed" : outcome.status;
      const actual: (string | undefined)[] = [];
      if (loaded.status !== "ready") actual.push(token(loaded));
      else {
        for (let call = 0; call < testCase.calls; call++) actual.push(token(await loaded.instance.call("run", "")));
        await loaded.instance.close();
      }
      expect(actual, `${testCase.name}: outcomes`).toEqual(testCase.outcomes);
      expect(count, `${testCase.name}: host entries`).toBe(testCase.hostCalls);
    });
  }
  it("refuses a non-positive budget when the executor is created", () => {
    expect(() => createPluginExecutor({ hostcallCopyBytes: 0 })).toThrow(RangeError);
  });
});
