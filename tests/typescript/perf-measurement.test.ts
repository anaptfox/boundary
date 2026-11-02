import { afterEach, describe, expect, it, vi } from "vitest";
import { measure, measureSync } from "./perf/measure";

afterEach(() => vi.restoreAllMocks());

describe("performance measurement semantics", () => {
  it("keeps chronological batch durations and reports normalized batch means", () => {
    let clockMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const perCallMs = [2, 1, 9, 3, 6];
    let setups = 0;
    let calls = 0;
    const measured = measureSync(() => {
      clockMs += perCallMs[setups - 1]!;
      calls += 1;
    }, {
      warmup: 2,
      iters: 3,
      batchSize: 3,
      beforeEach: () => {
        clockMs += 1_000;
        setups += 1;
      },
    });

    expect(setups).toBe(5);
    expect(calls).toBe(15);
    expect(measured).toEqual({
      iters: 3,
      warmup: 2,
      batchSize: 3,
      timingMode: "sync-batch",
      sampleUnit: "ns",
      samplesNs: [27e6, 9e6, 18e6],
      statistic: "batch-mean",
      nsMedian: 6e6,
      nsP95: 9e6,
    });
  });

  it("awaits setup before the timer and includes asynchronous completion", async () => {
    let clockMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const perCallMs = [2, 9, 3, 6];
    let setups = 0;
    let calls = 0;
    const measured = await measure(async () => {
      expect(setups).toBe(calls + 1);
      await Promise.resolve();
      clockMs += perCallMs[calls]!;
      calls += 1;
    }, {
      warmup: 1,
      iters: 3,
      beforeEach: async () => {
        await Promise.resolve();
        clockMs += 1_000;
        setups += 1;
      },
    });

    expect(setups).toBe(4);
    expect(calls).toBe(4);
    expect(measured).toEqual({
      iters: 3,
      warmup: 1,
      batchSize: 1,
      timingMode: "async-single",
      sampleUnit: "ns",
      samplesNs: [9e6, 3e6, 6e6],
      statistic: "single-call",
      nsMedian: 6e6,
      nsP95: 9e6,
    });
  });

  it("labels unbatched synchronous calls and rejects invalid counts", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1).mockReturnValueOnce(4);
    expect(measureSync(() => undefined, { warmup: 0, iters: 1 })).toMatchObject({
      timingMode: "sync-single",
      batchSize: 1,
      statistic: "single-call",
      samplesNs: [3e6],
    });
    expect(() => measureSync(() => undefined, { warmup: 0, iters: 0 })).toThrow();
    expect(() => measureSync(() => undefined, { warmup: -1, iters: 1 })).toThrow();
    expect(() => measureSync(() => undefined, { warmup: 0, iters: 1, batchSize: 0 })).toThrow();
  });
});
