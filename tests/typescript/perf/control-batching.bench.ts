// @vitest-environment node
import { expect, it } from "vitest";
import {
  CONTROL_RECORD_VERSION, listControl, proposalDigest,
  type ControlJournal, type ProposalRecord,
} from "@foxworth/boundary/control";
import { MemoryJournal } from "@foxworth/boundary/testing";
import { measure, recordCase } from "./measure";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const statusMethods = new Set(["findGrantByProposalDigest", "findAttemptByProposalDigest", "findReceiptByProposalDigest"]);

async function seed(count: number) {
  const journal = new MemoryJournal();
  const tenant = Object.freeze({ kind: "list", id: "benchmark" });
  for (let index = 0; index < count; index++) {
    const identity = {
      version: CONTROL_RECORD_VERSION, id: `proposal-${String(index).padStart(4, "0")}`,
      bindingDigest: digest("4"), projectionDigest: digest("5"),
      installationId: "installation:perf:control", installationDigest: digest("6"),
      expectedProgramDigest: digest("7"), actualProgramDigest: digest("7"), programDigest: digest("0"),
      controlDigest: digest("2"), interactionId: "perf.publish",
      expectedContractDigest: digest("8"), contractDigest: digest("3"),
      requestRealizationId: "realization:perf:request", executionRealizationId: "realization:perf:execute",
      controlRealizationDigest: digest("9"), requestedBy: "benchmark", subject: tenant,
      baselineSummary: "unpublished", effects: [{ kind: "network", action: "publish", resource: "benchmark", details: { index } }],
      preview: { index }, createdAt: 1000 + index, input: { index }, baseline: { revision: index }, state: { index },
    };
    await journal.createProposal({ ...identity, proposalDigest: proposalDigest(identity) } as ProposalRecord);
  }
  return { journal, scope: Object.freeze({ interactionIds: Object.freeze(["perf.publish"]), tenant }) };
}

/** Simulates a journal pool with eight concurrent requests and fixed service time. */
function journalView(journal: MemoryJournal, batch: boolean, serviceMs: number) {
  let individualReads = 0, batchReads = 0, maxBatchSize = 0, active = 0;
  const waiters: (() => void)[] = [];
  const methods = new Map<PropertyKey, unknown>();
  async function request(run: () => unknown) {
    if (serviceMs === 0) return run();
    if (active >= 8) await new Promise<void>(resolve => { waiters.push(resolve); });
    else active++;
    try {
      await new Promise<void>(resolve => { setTimeout(resolve, serviceMs); });
      return await run();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  }
  const view: ControlJournal = new Proxy(journal, {
    get(target, key) {
      if (key === "readStatusChains" && !batch) return undefined;
      if (methods.has(key)) return methods.get(key);
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const wrapped = key === "readStatusChains"
        ? (digests: readonly string[]) => {
            batchReads++; maxBatchSize = Math.max(maxBatchSize, digests.length);
            return request(() => Reflect.apply(value, target, [digests]));
          }
        : typeof key === "string" && statusMethods.has(key)
          ? (...args: unknown[]) => {
              individualReads++;
              return request(() => Reflect.apply(value, target, args));
            }
          : value.bind(target);
      methods.set(key, wrapped);
      return wrapped;
    },
  });
  return { view, counts: () => ({ individualReads, batchReads, maxBatchSize }),
    reset() { individualReads = 0; batchReads = 0; maxBatchSize = 0; } };
}

it("records complete Control lists with batch capability and bounded journal I/O", async () => {
  for (const count of [50, 200]) {
    const f = await seed(count);
    const expected = await listControl(f.journal, undefined, f.scope);
    expect(expected).toHaveLength(count);
    for (const serviceMs of count === 200 ? [0, 2] : [0]) for (const batch of [false, true]) {
      const fixture = journalView(f.journal, batch, serviceMs);
      const call = () => listControl(fixture.view, undefined, f.scope);
      expect(await call()).toEqual(expected);
      fixture.reset();
      await call();
      const diagnostic = fixture.counts();
      recordCase({ id: `ts.control.complete.${count}.${batch ? "batch-capable" : "fallback"}.pool8-${serviceMs}ms`,
        lang: "ts", class: "list",
        extra: { proposals: count, serviceMs, poolConcurrency: 8, ...diagnostic },
        ...await measure(call, { warmup: serviceMs ? 1 : 2, iters: serviceMs ? 6 : 12 }) });
    }
  }
}, 180_000);
