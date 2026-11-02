import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, Sha256Digest } from "../../packages/core/program/index";
import {
  createControlCapabilities,
  type AttemptRecord,
  type ControlHook,
  type ControlHost,
  type ControlPolicy,
  type ControlTarget,
  type EffectResult,
  type ReceiptRecord,
} from "../../packages/core/control/index";
import {
  MemoryJournal,
  TestClock,
  TestIds,
} from "../../packages/core/control/testing";

type Actor = { readonly id: string };
type HostContext = { readonly tenant: string };
type Input = { readonly body: string };
type Output = { readonly body: string };
type State = { readonly previous: string };
type Preview = { readonly next: string };
type CommitFault = "before" | "after";
type CasFault = "false" | CommitFault;

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const target: ControlTarget = Object.freeze({
  bindingDigest: digest("5"),
  projectionDigest: digest("6"),
  installationId: "installation:faults:1",
  installationDigest: digest("7"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("1"),
  interactionId: "faults.replace",
  expectedContractDigest: digest("9"),
  contractDigest: digest("2"),
  requestRealizationId: "realization:faults.replace:request:1",
  executionRealizationId: "realization:faults.replace:execute:1",
  controlRealizationDigest: digest("4"),
  controlDigest: digest("3"),
});

const readerScope = Object.freeze({
  interactionIds: Object.freeze([target.interactionId]),
  tenant: Object.freeze({ kind: "document", id: "singleton" }),
});

const context: HostContext = Object.freeze({ tenant: "tenant-a" });

function parseObject<Value extends JsonValue>(
  value: unknown,
  guard: (value: Record<string, unknown>) => boolean,
): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  if (!guard(value as Record<string, unknown>)) throw new Error("invalid value");
  return value as Value;
}

const executorActor: Actor = { id: "executor" };

const allow: ControlPolicy<Actor> = {
  identify: (actor) => actor.id,
  request: () => ({ allow: true }),
  approve: () => ({ allow: true }),
  grant: () => ({ allow: true }),
  execute: () => ({ allow: true }),
  reconcile: () => ({ allow: true }),
  preflight: () => undefined,
};

class FaultClock extends TestClock {
  fail = false;

  override now(): number {
    if (this.fail) throw new Error("clock unavailable");
    return super.now();
  }
}

class FaultJournal extends MemoryJournal {
  createAttemptFault: CommitFault | undefined;
  outputCasFault: CasFault | undefined;
  directCompletionCasFault: CasFault | undefined;
  reconciliationClaimCasFault: CasFault | undefined;
  reconciliationCompletionCasFault: CasFault | undefined;
  receiptCreateFault: CommitFault | undefined;
  failReceiptLookupAfterCompletion = 0;
  failReceiptRecoveryLookupAfterCommit = false;

  #completedAttemptPersisted = false;

  override async createAttempt(
    attempt: Parameters<MemoryJournal["createAttempt"]>[0],
  ): ReturnType<MemoryJournal["createAttempt"]> {
    const fault = this.createAttemptFault;
    this.createAttemptFault = undefined;
    if (fault === "before") throw new Error("attempt create failed");
    const result = await super.createAttempt(attempt);
    if (fault === "after") {
      throw new Error("attempt create commit is ambiguous");
    }
    return result;
  }

  override async compareAndSwapAttempt(
    attempt: AttemptRecord,
    expectedRecordRevision: number,
  ): Promise<boolean> {
    const fault = this.takeCasFault(attempt, await this.getAttempt(attempt.id));
    if (fault === "false") return false;
    if (fault === "before") throw new Error("attempt CAS failed");
    const result = await super.compareAndSwapAttempt(
      attempt,
      expectedRecordRevision,
    );
    if (result && attempt.execution === "completed") {
      this.#completedAttemptPersisted = true;
    }
    if (fault === "after") throw new Error("attempt CAS commit is ambiguous");
    return result;
  }

  override async createReceipt(
    receipt: ReceiptRecord,
  ): ReturnType<MemoryJournal["createReceipt"]> {
    const fault = this.receiptCreateFault;
    this.receiptCreateFault = undefined;
    if (fault === "before") throw new Error("receipt create failed");
    const result = await super.createReceipt(receipt);
    if (fault === "after") {
      if (this.failReceiptRecoveryLookupAfterCommit) {
        this.failReceiptRecoveryLookupAfterCommit = false;
        this.failReceiptLookupAfterCompletion += 1;
      }
      throw new Error("receipt create commit is ambiguous");
    }
    return result;
  }

  override async findReceiptByProposalDigest(
    digest: Parameters<MemoryJournal["findReceiptByProposalDigest"]>[0],
  ): ReturnType<MemoryJournal["findReceiptByProposalDigest"]> {
    if (
      this.#completedAttemptPersisted &&
      this.failReceiptLookupAfterCompletion > 0
    ) {
      this.failReceiptLookupAfterCompletion -= 1;
      throw new Error("receipt lookup is ambiguous");
    }
    return super.findReceiptByProposalDigest(digest);
  }

  private takeCasFault(attempt: AttemptRecord, prior: AttemptRecord | undefined): CasFault | undefined {
    if (prior?.output === undefined && attempt.output !== undefined && attempt.verification === "pending") {
      const fault = this.outputCasFault;
      this.outputCasFault = undefined;
      return fault;
    }
    if (attempt.execution === "completed" && attempt.verification === "verified" && attempt.lease.fence === 1) {
      const fault = this.directCompletionCasFault;
      this.directCompletionCasFault = undefined;
      return fault;
    }
    if (prior !== undefined && attempt.lease.fence > prior.lease.fence) {
      const fault = this.reconciliationClaimCasFault;
      this.reconciliationClaimCasFault = undefined;
      return fault;
    }
    if (
      attempt.execution === "completed" && attempt.verification === "verified" && attempt.lease.fence > 1
    ) {
      const fault = this.reconciliationCompletionCasFault;
      this.reconciliationCompletionCasFault = undefined;
      return fault;
    }
    return undefined;
  }
}

const faultJournals: FaultJournal[] = [];
afterEach(() => {
  for (const journal of faultJournals.splice(0)) {
    expect(journal.createAttemptFault).toBeUndefined();
    expect(journal.outputCasFault).toBeUndefined();
    expect(journal.directCompletionCasFault).toBeUndefined();
    expect(journal.reconciliationClaimCasFault).toBeUndefined();
    expect(journal.reconciliationCompletionCasFault).toBeUndefined();
    expect(journal.receiptCreateFault).toBeUndefined();
    expect(journal.failReceiptLookupAfterCompletion).toBe(0);
    expect(journal.failReceiptRecoveryLookupAfterCommit).toBe(false);
  }
});

type VerifyMode = "ok" | "false" | "throw";

function faultFixture(journal = new FaultJournal(new TestIds("fault"))) {
  faultJournals.push(journal);
  const clock = new FaultClock(100);
  let effect = "before";
  let applyCount = 0;
  let reconcileCount = 0;
  let verifyCount = 0;
  let verifyMode: VerifyMode = "ok";
  let failClockDuringNextVerification = false;
  let reconcileOverride: unknown;

  const hook: ControlHook<
    Input,
    Output,
    State,
    Preview,
    unknown,
    unknown,
    HostContext
  > = {
    realizationDigest: digest("4"),
    state: {},
    preview: {},
    plan: ({ input }) => ({
      subject: { kind: "document", id: "singleton" },
      baseline: { body: effect },
      baselineSummary: `body is ${effect}`,
      effects: [
        {
          kind: "memory",
          action: "replace",
          resource: "faults/singleton",
        },
      ],
      state: { previous: effect },
      preview: { next: input.body },
    }),
    apply: ({ input }) => {
      applyCount += 1;
      effect = input.body;
      return { body: effect };
    },
    verify: ({ output }) => {
      verifyCount += 1;
      if (failClockDuringNextVerification) {
        failClockDuringNextVerification = false;
        clock.fail = true;
      }
      if (verifyMode === "throw") throw new Error("verifier unavailable");
      if (verifyMode === "false") {
        return { ok: false as const, message: "effect is not proven" };
      }
      return output.body === effect
        ? { ok: true as const, evidence: { body: effect } }
        : { ok: false as const, message: "body differs" };
    },
    reconcile: ({ input }) => {
      reconcileCount += 1;
      if (reconcileOverride !== undefined) {
        return reconcileOverride as never;
      }
      return effect === input.body
        ? { status: "completed" as const, value: { body: effect } }
        : {
            status: "not-applied" as const,
            reason: "document retains its baseline",
          };
    },
  };
  const host: ControlHost<HostContext> = {
    inspect: () => ({
      installationId: target.installationId,
      installationDigest: target.installationDigest,
      programDigest: target.programDigest,
    }),
    resolve: () => ({
      target,
      hook,
      parseInput: (value) =>
        parseObject<Input & JsonValue>(
          value,
          (object) => typeof object["body"] === "string",
        ),
      parseState: (value) =>
        parseObject<State & JsonValue>(
          value,
          (object) => typeof object["previous"] === "string",
        ),
      parsePreview: (value) =>
        parseObject<Preview & JsonValue>(
          value,
          (object) => typeof object["next"] === "string",
        ),
      parseOutput: (value) =>
        parseObject<Output & JsonValue>(
          value,
          (object) => typeof object["body"] === "string",
        ),
    }),
  };

  const capabilities = createControlCapabilities(
    {
      journal,
      policy: allow,
      clock,
      executor: { owner: "executor-a" },
      lease: { durationMs: 50 },
    },
    host,
    readerScope,
  );

  return {
    capabilities,
    clock,
    journal,
    applyCount: () => applyCount,
    reconcileCount: () => reconcileCount,
    verifyCount: () => verifyCount,
    effect: () => effect,
    setVerifyMode(mode: VerifyMode) {
      verifyMode = mode;
    },
    failClockDuringVerification() {
      failClockDuringNextVerification = true;
    },
    setReconcileResult(value: unknown) {
      reconcileOverride = value;
    },
  };
}

async function authorized(fixture: ReturnType<typeof faultFixture>) {
  const proposal = await fixture.capabilities.requester.request({
    actor: { id: "requester" },
    context,
    target,
    input: { body: "after" },
  });
  await fixture.capabilities.admin.approve(proposal, { id: "reviewer" });
  const grant = await fixture.capabilities.admin.grant(proposal, { id: "owner" });
  return { grant, proposal };
}

function uncertain<Output>(result: EffectResult<Output>) {
  expect(result).toMatchObject({ status: "uncertain" });
  if (result.status !== "uncertain") throw new Error("expected uncertainty");
  return result.attempt;
}

describe("control crash-boundary conformance", () => {
  it("contains an attempt create that persisted before throwing", async () => {
    const fixture = faultFixture();
    fixture.journal.createAttemptFault = "after";
    const { grant, proposal } = await authorized(fixture);

    const first = await fixture.capabilities.admin.execute(grant, executorActor, context);
    const attempt = uncertain(first);
    expect(fixture.applyCount()).toBe(0);
    await expect(
      fixture.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).resolves.toMatchObject({ id: attempt.id, execution: "started" });

    expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(first);
    expect(fixture.applyCount()).toBe(0);

    fixture.clock.advance(51);
    await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toEqual({
      status: "not-applied",
      reason: "document retains its baseline",
    });
    expect(fixture.applyCount()).toBe(0);
    expect(fixture.reconcileCount()).toBe(1);
  });

  it("keeps malformed not-applied reconciliation evidence uncertain", async () => {
    const fixture = faultFixture();
    fixture.journal.createAttemptFault = "after";
    const { grant } = await authorized(fixture);
    const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));

    fixture.setReconcileResult({ status: "not-applied" });
    fixture.clock.advance(51);
    const result = await fixture.capabilities.admin.reconcile(attempt, executorActor, context);

    uncertain(result);
    expect(result).not.toHaveProperty("reason");
    expect(fixture.applyCount()).toBe(0);
    expect(fixture.reconcileCount()).toBe(1);
  });

  it("may safely retry after a create failed before persistence is confirmed absent", async () => {
    const fixture = faultFixture();
    fixture.journal.createAttemptFault = "before";
    const { grant, proposal } = await authorized(fixture);

    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(0);
    await expect(
      fixture.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).resolves.toBeUndefined();

    await expect(fixture.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(fixture.applyCount()).toBe(1);
  });

  it.each([
    ["lost output CAS", "false", false, 1],
    ["output commit then throw", "after", true, 0],
  ] as const)(
    "contains %s and recovers without reapplying",
    async (_label, fault, outputPersisted, expectedReconciliations) => {
      const fixture = faultFixture();
      fixture.journal.outputCasFault = fault;
      const { grant, proposal } = await authorized(fixture);

      const first = await fixture.capabilities.admin.execute(grant, executorActor, context);
      const attempt = uncertain(first);
      expect(fixture.applyCount()).toBe(1);
      expect(fixture.effect()).toBe("after");
      const durable = await fixture.journal.findAttemptByProposalDigest(
        proposal.proposalDigest,
      );
      if (outputPersisted) {
        expect(durable).toMatchObject({ output: { body: "after" } });
      } else {
        expect(durable).not.toHaveProperty("output");
      }
      uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
      expect(fixture.applyCount()).toBe(1);

      fixture.clock.advance(51);
      await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
        status: "completed",
        value: { body: "after" },
      });
      expect(fixture.applyCount()).toBe(1);
      expect(fixture.reconcileCount()).toBe(expectedReconciliations);
    },
  );

  it("contains a verifier throw and completes later from the persisted output", async () => {
    const fixture = faultFixture();
    fixture.setVerifyMode("throw");
    const { grant } = await authorized(fixture);

    const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);
    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    fixture.setVerifyMode("ok");
    fixture.clock.advance(51);
    await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(fixture.applyCount()).toBe(1);
    expect(fixture.reconcileCount()).toBe(0);
  });

  it("records verifier rejection as uncertainty without reapplying", async () => {
    const fixture = faultFixture();
    fixture.setVerifyMode("false");
    const { grant, proposal } = await authorized(fixture);

    const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);
    await expect(
      fixture.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).resolves.toMatchObject({
      execution: "uncertain",
      verification: "failed",
      message: "effect is not proven",
    });
    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    fixture.setVerifyMode("ok");
    fixture.clock.advance(51);
    await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(fixture.applyCount()).toBe(1);
  });

  it("contains a clock failure while recording verifier rejection", async () => {
    const fixture = faultFixture();
    fixture.setVerifyMode("false");
    fixture.failClockDuringVerification();
    const { grant } = await authorized(fixture);

    const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);
    expect(fixture.verifyCount()).toBe(1);

    fixture.clock.fail = false;
    fixture.setVerifyMode("ok");
    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    fixture.clock.advance(51);
    await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(fixture.applyCount()).toBe(1);
  });

  it("contains a lost completion CAS and recovers from the saved output", async () => {
    const fixture = faultFixture();
    fixture.journal.directCompletionCasFault = "false";
    const { grant } = await authorized(fixture);

    const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);
    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    fixture.clock.advance(51);
    await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(fixture.applyCount()).toBe(1);
  });

  it("discovers a completion CAS that committed before throwing", async () => {
    const fixture = faultFixture();
    fixture.journal.directCompletionCasFault = "after";
    const { grant } = await authorized(fixture);

    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    const completed = await fixture.capabilities.admin.execute(grant, executorActor, context);
    expect(completed).toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(completed);
    expect(fixture.applyCount()).toBe(1);
  });

  it("recovers when the first post-completion receipt lookup is unavailable", async () => {
    const fixture = faultFixture();
    fixture.journal.failReceiptLookupAfterCompletion = 1;
    const { grant } = await authorized(fixture);

    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    expect(fixture.applyCount()).toBe(1);

    const completed = await fixture.capabilities.admin.execute(grant, executorActor, context);
    expect(completed).toMatchObject({ status: "completed" });
    expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(completed);
    expect(fixture.applyCount()).toBe(1);
  });

  it("recovers after receipt creation failed before persistence", async () => {
    const fixture = faultFixture();
    fixture.journal.receiptCreateFault = "before";
    const { grant } = await authorized(fixture);

    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    const completed = await fixture.capabilities.admin.execute(grant, executorActor, context);
    expect(completed).toMatchObject({ status: "completed" });
    expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(completed);
    expect(fixture.applyCount()).toBe(1);
  });

  it("returns the original receipt after receipt commit ambiguity", async () => {
    const fixture = faultFixture();
    fixture.journal.receiptCreateFault = "after";
    fixture.journal.failReceiptRecoveryLookupAfterCommit = true;
    const { grant, proposal } = await authorized(fixture);

    uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
    const stored = await fixture.journal.findReceiptByProposalDigest(
      proposal.proposalDigest,
    );
    expect(stored).toBeDefined();

    const replay = await fixture.capabilities.admin.execute(grant, executorActor, context);
    expect(replay).toMatchObject({ status: "completed", receipt: stored });
    expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(replay);
    expect(fixture.applyCount()).toBe(1);
  });

  it.each(["false", "before", "after"] as const)(
    "contains a reconciliation claim CAS fault (%s)",
    async (fault) => {
      const fixture = faultFixture();
      fixture.journal.outputCasFault = "false";
      const { grant } = await authorized(fixture);
      const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
      fixture.clock.advance(51);
      fixture.journal.reconciliationClaimCasFault = fault;

      uncertain(await fixture.capabilities.admin.reconcile(attempt, executorActor, context));
      expect(fixture.reconcileCount()).toBe(0);
      expect(fixture.applyCount()).toBe(1);

      if (fault === "after") fixture.clock.advance(51);
      await expect(fixture.capabilities.admin.reconcile(attempt, executorActor, context)).resolves.toMatchObject({
        status: "completed",
        value: { body: "after" },
      });
      expect(fixture.reconcileCount()).toBe(1);
      expect(fixture.applyCount()).toBe(1);
    },
  );

  it.each(["false", "after"] as const)(
    "contains a reconciliation completion CAS fault (%s)",
    async (fault) => {
      const fixture = faultFixture();
      fixture.journal.outputCasFault = "false";
      const { grant } = await authorized(fixture);
      const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
      fixture.clock.advance(51);
      fixture.journal.reconciliationCompletionCasFault = fault;

      uncertain(await fixture.capabilities.admin.reconcile(attempt, executorActor, context));
      expect(fixture.reconcileCount()).toBe(1);
      expect(fixture.applyCount()).toBe(1);

      const recovered =
        fault === "after"
          ? await fixture.capabilities.admin.execute(grant, executorActor, context)
          : await (async () => {
              fixture.clock.advance(51);
              return fixture.capabilities.admin.reconcile(attempt, executorActor, context);
            })();
      expect(recovered).toMatchObject({
        status: "completed",
        value: { body: "after" },
      });
      expect(fixture.applyCount()).toBe(1);
    },
  );

  it.each(["lookup", "create"] as const)(
    "contains a receipt %s fault after reconciliation completes",
    async (fault) => {
      const fixture = faultFixture();
      fixture.journal.outputCasFault = "false";
      if (fault === "lookup") {
        fixture.journal.failReceiptLookupAfterCompletion = 1;
      } else {
        fixture.journal.receiptCreateFault = "after";
        fixture.journal.failReceiptRecoveryLookupAfterCommit = true;
      }
      const { grant } = await authorized(fixture);
      const attempt = uncertain(await fixture.capabilities.admin.execute(grant, executorActor, context));
      fixture.clock.advance(51);

      uncertain(await fixture.capabilities.admin.reconcile(attempt, executorActor, context));
      expect(fixture.applyCount()).toBe(1);
      expect(fixture.reconcileCount()).toBe(1);

      const completed = await fixture.capabilities.admin.execute(grant, executorActor, context);
      expect(completed).toMatchObject({ status: "completed" });
      expect(await fixture.capabilities.admin.execute(grant, executorActor, context)).toEqual(completed);
      expect(fixture.applyCount()).toBe(1);
    },
  );
});
