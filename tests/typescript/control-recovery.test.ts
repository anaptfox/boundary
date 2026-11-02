import { describe, expect, it } from "vitest";
import type { JsonValue, Sha256Digest } from "../../packages/core/program/index";
import {
  ControlError,
  createControlCapabilities,
  type ControlHook,
  type ControlHost,
  type ControlJournal,
  type ControlPolicy,
  type ControlTarget,
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

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const target: ControlTarget = Object.freeze({
  bindingDigest: digest("5"),
  projectionDigest: digest("6"),
  installationId: "installation:recovery:1",
  installationDigest: digest("7"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("1"),
  interactionId: "recovery.replace",
  expectedContractDigest: digest("9"),
  contractDigest: digest("2"),
  requestRealizationId: "realization:recovery.replace:request:1",
  executionRealizationId: "realization:recovery.replace:execute:1",
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

function policy(preflight: () => void = () => undefined): ControlPolicy<Actor> {
  return {
    identify: ({ id }) => id,
    request: () => ({ allow: true }),
    approve: () => ({ allow: true }),
    grant: () => ({ allow: true }),
    execute: () => ({ allow: true }),
    reconcile: () => ({ allow: true }),
    preflight,
  };
}

function recoveryFixture(options: {
  readonly journal?: ControlJournal;
  readonly journalFactory?: (clock: TestClock) => ControlJournal;
  readonly preflight?: () => void;
} = {}) {
  const clock = new TestClock(100);
  const journal =
    options.journalFactory?.(clock) ??
    options.journal ??
    new MemoryJournal(new TestIds("recovery"));
  let effect = "before";
  let applyCount = 0;
  let reconcileCount = 0;
  let crashAfterApply = false;
  let renewDuringApply = false;
  let blockApply = false;
  let acceptedFence = 0;
  let announceApply!: () => void;
  let releaseApply!: () => void;
  let enteredApply = Promise.resolve();
  let applyBarrier = Promise.resolve();

  const resetBarrier = () => {
    enteredApply = new Promise<void>((resolve) => {
      announceApply = resolve;
    });
    applyBarrier = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
  };

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
          resource: "recovery/singleton",
        },
      ],
      state: { previous: effect },
      preview: { next: input.body },
    }),
    async apply({ input, lease }) {
      applyCount += 1;
      let fence = lease.fence;
      if (renewDuringApply) {
        const renewed = await lease.renew();
        fence = renewed.fence;
        acceptedFence = renewed.fence;
      }
      if (blockApply) {
        announceApply();
        await applyBarrier;
      }
      if (fence < acceptedFence) throw new Error("stale executor fence");
      acceptedFence = Math.max(acceptedFence, lease.fence);
      effect = input.body;
      if (crashAfterApply) throw new Error("connection lost after effect");
      return { body: effect };
    },
    verify: ({ output }) =>
      output.body === effect
        ? { ok: true, evidence: { body: effect } }
        : { ok: false, message: "body differs" },
    reconcile: ({ input, lease }) => {
      reconcileCount += 1;
      acceptedFence = Math.max(acceptedFence, lease.fence);
      return effect === input.body
        ? { status: "completed", value: { body: effect } }
        : {
            status: "not-applied",
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

  const capabilitiesFor = (owner: string) =>
    createControlCapabilities(
      {
        journal,
        policy: policy(options.preflight),
        clock,
        executor: { owner },
        lease: { durationMs: 50 },
      },
      host,
      readerScope,
    );

  return {
    capabilitiesFor,
    clock,
    effect: () => effect,
    applyCount: () => applyCount,
    reconcileCount: () => reconcileCount,
    journal,
    setCrashAfterApply(value: boolean) {
      crashAfterApply = value;
    },
    setRenewDuringApply(value: boolean) {
      renewDuringApply = value;
    },
    blockNextApply() {
      blockApply = true;
      resetBarrier();
      return { entered: enteredApply, release: () => releaseApply() };
    },
  };
}

async function authorized(
  fixture: ReturnType<typeof recoveryFixture>,
  owner = "executor-a",
  body = "after",
) {
  const capabilities = fixture.capabilitiesFor(owner);
  const proposal = await capabilities.requester.request<Preview, Output>({
    actor: { id: "requester" },
    context,
    target,
    input: { body },
  });
  await capabilities.admin.approve(proposal, { id: "reviewer" });
  const grant = await capabilities.admin.grant(proposal, { id: "owner" });
  return { capabilities, grant, proposal };
}

describe("control exact recovery", () => {
  it("contains post-attempt failure, never retries unknown, then reconciles reality", async () => {
    const fixture = recoveryFixture();
    fixture.setCrashAfterApply(true);
    const { capabilities, grant, proposal } = await authorized(fixture);

    const uncertain = await capabilities.admin.execute(grant, executorActor, context);
    expect(uncertain).toMatchObject({
      status: "uncertain",
      attempt: { controlDigest: proposal.controlDigest },
    });
    if (uncertain.status !== "uncertain") throw new Error("expected uncertainty");
    expect(fixture.effect()).toBe("after");
    expect(fixture.applyCount()).toBe(1);

    expect(await capabilities.admin.execute(grant, executorActor, context)).toEqual(uncertain);
    expect(fixture.applyCount()).toBe(1);
    const stillUncertain = await capabilities.admin.reconcile(
      uncertain.attempt,
      executorActor,
      context,
    );
    expect(stillUncertain).toEqual(uncertain);
    if (stillUncertain.status !== "uncertain") throw new Error("expected uncertainty");
    expect(fixture.reconcileCount()).toBe(0);

    fixture.clock.advance(51);
    fixture.setCrashAfterApply(false);
    const recovered = await capabilities.admin.reconcile(stillUncertain.attempt, executorActor, context);
    expect(recovered).toMatchObject({
      status: "completed",
      value: { body: "after" },
      receipt: { controlDigest: proposal.controlDigest },
    });
    if (recovered.status !== "completed") throw new Error("expected completion");
    recovered.value.body satisfies string;
    expect(fixture.reconcileCount()).toBe(1);
    expect(await capabilities.admin.execute(grant, executorActor, context)).toEqual(recovered);
    expect(fixture.applyCount()).toBe(1);
  });

  it("throws preflight failure before creating an attempt", async () => {
    const fixture = recoveryFixture({
      preflight: () => {
        throw new Error("baseline changed");
      },
    });
    const { capabilities, grant, proposal } = await authorized(fixture);

    await expect(capabilities.admin.execute(grant, executorActor, context)).rejects.toMatchObject({
      name: "ControlError",
      code: "CONTROL_PREFLIGHT_FAILED",
    } satisfies Partial<ControlError>);
    expect(
      await fixture.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).toBeUndefined();
    expect(fixture.applyCount()).toBe(0);
  });

  it("does not begin apply when attempt persistence outlives its lease", async () => {
    const fixture = recoveryFixture({
      journalFactory: (clock) =>
        new (class extends MemoryJournal {
          override async createAttempt(
            attempt: Parameters<MemoryJournal["createAttempt"]>[0],
          ) {
            const created = await super.createAttempt(attempt);
            clock.advance(51);
            return created;
          }
        })(new TestIds("slow-attempt")),
    });
    const { capabilities, grant, proposal } = await authorized(fixture);

    await expect(capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
      status: "uncertain",
    });
    expect(fixture.applyCount()).toBe(0);
    await expect(
      fixture.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).resolves.toMatchObject({ execution: "uncertain" });
  });

  it("renews a lease with a monotonic fence before the effect boundary", async () => {
    const fixture = recoveryFixture();
    fixture.setRenewDuringApply(true);
    const { capabilities, grant, proposal } = await authorized(fixture);

    await expect(capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
      status: "completed",
    });
    const attempt = await fixture.journal.findAttemptByProposalDigest(
      proposal.proposalDigest,
    );
    expect(attempt?.lease).toMatchObject({ owner: "executor-a", fence: 2 });
    expect(attempt?.recordRevision).toBeGreaterThanOrEqual(4);
  });

  it("CAS-claims an expired started attempt and never re-applies", async () => {
    const fixture = recoveryFixture();
    const { capabilities: first, grant } = await authorized(
      fixture,
      "executor-a",
    );
    const barrier = fixture.blockNextApply();
    const executing = first.admin.execute(grant, executorActor, context);
    await barrier.entered;
    const attempt = await fixture.journal.findAttemptByProposalDigest(
      grant.proposalDigest,
    );
    if (!attempt) throw new Error("attempt not created");

    const recovery = fixture.capabilitiesFor("executor-b");
    await expect(recovery.admin.reconcile(attempt.id, executorActor, context)).resolves.toMatchObject({
      status: "uncertain",
    });
    expect(fixture.reconcileCount()).toBe(0);

    fixture.clock.advance(51);
    await expect(recovery.admin.reconcile(attempt.id, executorActor, context)).resolves.toEqual({
      status: "not-applied",
      reason: "document retains its baseline",
    });
    const claimed = await fixture.journal.getAttempt(attempt.id);
    expect(claimed?.lease).toMatchObject({ owner: "executor-b", fence: 2 });
    expect(fixture.reconcileCount()).toBe(1);

    barrier.release();
    await expect(executing).resolves.toMatchObject({ status: "uncertain" });
    expect(fixture.effect()).toBe("before");
    expect(fixture.applyCount()).toBe(1);
  });
});
