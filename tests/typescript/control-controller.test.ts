import { describe, expect, it } from "vitest";
import type { JsonValue, Sha256Digest } from "../../packages/core/program/index";
import {
  control,
  createControlCapabilities,
  installControlPart,
  isControlPart,
  type Approval,
  type AttemptRecord,
  type ControlHook,
  type ControlHost,
  type ControlPolicy,
  type ControlTarget,
  type Grant,
  type ProposalRecord,
  type ReceiptRecord,
} from "../../packages/core/control/index";
import {
  MemoryJournal,
  TestClock,
  TestIds,
} from "../../packages/core/control/testing";

type Actor = { readonly id: string; readonly session: string };
type HostContext = {
  readonly tenant: string;
  readonly capability: { readonly token: string };
};
type Input = { readonly body: string };
type Output = { readonly body: string };
type State = { readonly previous: string };
type Preview = { readonly sentence: string };

const digest = (value: string): Sha256Digest =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

const target: ControlTarget = Object.freeze({
  bindingDigest: digest("5"),
  projectionDigest: digest("6"),
  installationId: "installation:documents:1",
  installationDigest: digest("7"),
  expectedProgramDigest: digest("8"),
  actualProgramDigest: digest("8"),
  programDigest: digest("1"),
  interactionId: "documents.replace",
  expectedContractDigest: digest("9"),
  contractDigest: digest("2"),
  requestRealizationId: "realization:documents.replace:request:1",
  executionRealizationId: "realization:documents.replace:execute:1",
  controlRealizationDigest: digest("4"),
  controlDigest: digest("3"),
});

const readerScope = Object.freeze({
  interactionIds: Object.freeze([target.interactionId]),
  tenant: Object.freeze({ kind: "document", id: "tenant-a" }),
});

const executorActor: Actor = { id: "executor", session: "session-executor" };

const allow: ControlPolicy<Actor> = {
  identify: (actor) => actor.id,
  request: () => ({ allow: true }),
  approve: () => ({ allow: true }),
  grant: () => ({ allow: true }),
  execute: () => ({ allow: true }),
  reconcile: () => ({ allow: true }),
  preflight: () => undefined,
};

class RecoveryLookupFaultJournal extends MemoryJournal {
  fault: "grant" | "proposal" | undefined;

  override async getGrant(
    id: string,
  ): ReturnType<MemoryJournal["getGrant"]> {
    if (this.fault === "grant") throw new Error("grant store unavailable");
    return super.getGrant(id);
  }

  override async getProposal(
    id: string,
  ): ReturnType<MemoryJournal["getProposal"]> {
    if (this.fault === "proposal") {
      throw new Error("proposal store unavailable");
    }
    return super.getProposal(id);
  }
}

class SubstitutingApprovalJournal extends MemoryJournal {
  readonly #field: "approvedBy" | "approvedAt";

  constructor(field: "approvedBy" | "approvedAt") {
    super(new TestIds(`substitute-${field}`));
    this.#field = field;
  }

  override async createApproval(approval: Approval) {
    return {
      kind: "created" as const,
      record: Object.freeze({
        ...approval,
        ...(this.#field === "approvedBy"
          ? { approvedBy: "substituted-reviewer" }
          : { approvedAt: approval.approvedAt + 1 }),
      }),
    };
  }
}

class MutableApprovalJournal extends MemoryJournal {
  #record: (Approval & { approvedBy: string; approvedAt: number }) | undefined;

  override async createApproval(approval: Approval) {
    const record = { ...approval };
    this.#record = record;
    return { kind: "created" as const, record };
  }

  mutate(field: "approvedBy" | "approvedAt"): void {
    if (!this.#record) return;
    if (field === "approvedBy") {
      this.#record.approvedBy = "mutated-reviewer";
    } else {
      this.#record.approvedAt += 1;
    }
  }
}

class MutableApprovalListJournal extends MemoryJournal {
  #records: Array<Approval & { approvedBy: string; approvedAt: number }> = [];

  override async listApprovals(
    proposalDigest: Sha256Digest,
  ): Promise<readonly Approval[]> {
    const records = (await super.listApprovals(proposalDigest)).map(
      (approval) => ({ ...approval }),
    );
    this.#records = records;
    return records;
  }

  mutate(field: "approvedBy" | "approvedAt"): void {
    const approval = this.#records[0];
    if (!approval) return;
    if (field === "approvedBy") approval.approvedBy = "mutated-reviewer";
    else approval.approvedAt += 1;
  }
}

class MalformedApprovalListJournal extends MemoryJournal {
  readonly #shape: "extra" | "sparse";

  constructor(shape: "extra" | "sparse") {
    super(new TestIds(`malformed-approval-list-${shape}`));
    this.#shape = shape;
  }

  override async listApprovals(
    proposalDigest: Sha256Digest,
  ): Promise<readonly Approval[]> {
    const approvals = await super.listApprovals(proposalDigest);
    if (this.#shape === "extra") {
      return approvals.map((approval) => ({
        ...approval,
        ambientAuthority: "must-not-cross",
      }));
    }
    const sparse = new Array<Approval>(approvals.length + 1);
    sparse[1] = approvals[0]!;
    return sparse;
  }
}

class DuplicateApprovalListJournal extends MemoryJournal {
  readonly #mode: "record" | "actor";

  constructor(mode: "record" | "actor") {
    super(new TestIds(`duplicate-approval-${mode}`));
    this.#mode = mode;
  }

  override async listApprovals(
    proposalDigest: Sha256Digest,
  ): Promise<readonly Approval[]> {
    const approval = (await super.listApprovals(proposalDigest))[0]!;
    return [
      { ...approval },
      this.#mode === "record"
        ? { ...approval }
        : {
            ...approval,
            id: `${approval.id}-same-actor`,
            approvedAt: approval.approvedAt + 1,
          },
    ];
  }
}

class SubstitutingProposalJournal extends MemoryJournal {
  override async createProposal(proposal: ProposalRecord) {
    return {
      kind: "created" as const,
      record: { ...proposal, requestedBy: "substituted-requester" },
    };
  }
}

class SubstitutingGrantJournal extends MemoryJournal {
  readonly #field: "id" | "issuedAt";

  constructor(field: "id" | "issuedAt") {
    super(new TestIds(`substitute-grant-${field}`));
    this.#field = field;
  }

  override async createGrant(grant: Grant) {
    return {
      kind: "created" as const,
      record: {
        ...grant,
        ...(this.#field === "id"
          ? { id: `${grant.id}-substituted` }
          : { issuedAt: grant.issuedAt + 1 }),
      },
    };
  }
}

class SubstitutingAttemptJournal extends MemoryJournal {
  readonly #field: "lease" | "fence" | "recordRevision" | "execution";

  constructor(field: "lease" | "fence" | "recordRevision" | "execution") {
    super(new TestIds(`substitute-attempt-${field}`));
    this.#field = field;
  }

  override async createAttempt(attempt: AttemptRecord) {
    return {
      kind: "created" as const,
      record: {
        ...attempt,
        ...(this.#field === "lease"
          ? { lease: { ...attempt.lease, owner: "substituted-executor" } }
          : {}),
        ...(this.#field === "fence"
          ? { lease: { ...attempt.lease, fence: attempt.lease.fence + 1 } }
          : {}),
        ...(this.#field === "recordRevision"
          ? { recordRevision: attempt.recordRevision + 1 }
          : {}),
        ...(this.#field === "execution"
          ? { execution: "uncertain" as const }
          : {}),
      },
    };
  }
}

class ReceiptBoundaryJournal extends MemoryJournal {
  readonly #mode: "substitute" | "mutate";
  readonly #field: "id" | "completedAt";
  #record: (ReceiptRecord & { id: string; completedAt: number }) | undefined;

  constructor(mode: "substitute" | "mutate", field: "id" | "completedAt") {
    super(new TestIds(`receipt-${mode}-${field}`));
    this.#mode = mode;
    this.#field = field;
  }

  override async createReceipt(receipt: ReceiptRecord) {
    const record = { ...receipt };
    if (this.#mode === "substitute") this.mutateRecord(record);
    if (this.#mode === "mutate") this.#record = record;
    return { kind: "created" as const, record };
  }

  mutate(): void {
    if (this.#record) this.mutateRecord(this.#record);
  }

  private mutateRecord(record: { id: string; completedAt: number }): void {
    if (this.#field === "id") record.id = `${record.id}-substituted`;
    else record.completedAt += 1;
  }
}

class MutableReceiptReadJournal extends MemoryJournal {
  readonly #failAfterReceiptCreate: boolean;
  #record: ReceiptRecord | undefined;

  constructor(failAfterReceiptCreate: boolean) {
    super(
      new TestIds(
        failAfterReceiptCreate ? "recovered-receipt" : "existing-receipt",
      ),
    );
    this.#failAfterReceiptCreate = failAfterReceiptCreate;
  }

  override async createReceipt(receipt: ReceiptRecord) {
    const result = await super.createReceipt(receipt);
    if (this.#failAfterReceiptCreate) {
      throw new Error("connection lost after receipt commit");
    }
    return result;
  }

  override async findReceiptByProposalDigest(proposalDigest: Sha256Digest) {
    const durable = await super.findReceiptByProposalDigest(proposalDigest);
    if (!durable) return undefined;
    const record = {
      ...durable,
      output: { ...(durable.output as { body: string }) },
      ...(durable.evidence === undefined
        ? {}
        : { evidence: { ...(durable.evidence as { body: string }) } }),
    };
    this.#record = record;
    return record;
  }

  mutate(): void {
    if (!this.#record) return;
    (this.#record.output as { body: string }).body = "tampered-output";
    if (this.#record.evidence) {
      (this.#record.evidence as { body: string }).body = "tampered-evidence";
    }
  }
}

class CrashBeforeReceiptJournal extends MemoryJournal {
  #crash = true;
  #attempt: AttemptRecord | undefined;

  override async createReceipt(receipt: ReceiptRecord) {
    if (this.#crash) throw new Error("crash before receipt commit");
    return super.createReceipt(receipt);
  }

  override async findAttemptByProposalDigest(proposalDigest: Sha256Digest) {
    const durable = await super.findAttemptByProposalDigest(proposalDigest);
    if (!durable) return undefined;
    const attempt = {
      ...durable,
      ...(durable.output === undefined
        ? {}
        : { output: { ...(durable.output as { body: string }) } }),
      ...(durable.evidence === undefined
        ? {}
        : { evidence: { ...(durable.evidence as { body: string }) } }),
    };
    this.#attempt = attempt;
    return attempt;
  }

  resume(): void {
    this.#crash = false;
  }

  mutateAttempt(): void {
    if (!this.#attempt) return;
    if (this.#attempt.output) {
      (this.#attempt.output as { body: string }).body = "tampered-output";
    }
    if (this.#attempt.evidence) {
      (this.#attempt.evidence as { body: string }).body = "tampered-evidence";
    }
  }
}

class KeySubstitutingJournal extends MemoryJournal {
  proposalId: string | undefined;
  grantId: string | undefined;
  attemptId: string | undefined;
  redirectAttemptAfterCas = false;
  #casAttempted = false;

  override async getProposal(id: string) {
    return super.getProposal(this.proposalId ?? id);
  }

  override async getGrant(id: string) {
    return super.getGrant(this.grantId ?? id);
  }

  override async getAttempt(id: string) {
    const redirect =
      this.attemptId !== undefined &&
      (!this.redirectAttemptAfterCas || this.#casAttempted);
    return super.getAttempt(redirect ? this.attemptId! : id);
  }

  override async compareAndSwapAttempt(
    attempt: AttemptRecord,
    expectedRecordRevision: number,
  ): Promise<boolean> {
    if (!this.redirectAttemptAfterCas) {
      return super.compareAndSwapAttempt(attempt, expectedRecordRevision);
    }
    this.#casAttempted = true;
    return false;
  }
}

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

function fixture(options: {
  readonly failAfterApply?: boolean;
  readonly journal?: MemoryJournal;
  readonly onResolve?: () => void | Promise<void>;
  readonly onParseOutput?: () => void | Promise<void>;
  readonly policy?: ControlPolicy<Actor>;
} = {}) {
  let body = "before";
  let currentProgramDigest = target.programDigest;
  let resolvedTarget: ControlTarget | undefined;
  const contexts: HostContext[] = [];
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
    plan({ input, context }) {
      contexts.push(context);
      return {
        subject: { kind: "document", id: context.tenant },
        baseline: { body },
        baselineSummary: `body is ${body}`,
        effects: [
          {
            kind: "memory",
            action: "replace",
            resource: `documents/${context.tenant}`,
          },
        ],
        state: { previous: body },
        preview: { sentence: `${body} -> ${input.body}` },
      };
    },
    apply({ input, context }) {
      contexts.push(context);
      body = input.body;
      if (options.failAfterApply) throw new Error("connection lost after effect");
      return { body };
    },
    verify({ output, context }) {
      contexts.push(context);
      return output.body === body
        ? { ok: true, evidence: { body } }
        : { ok: false, message: "body differs" };
    },
    reconcile({ input, context }) {
      contexts.push(context);
      return body === input.body
        ? { status: "completed", value: { body } }
        : { status: "not-applied", reason: "body is unchanged" };
    },
  };
  const host: ControlHost<HostContext> = {
    inspect: () => ({
      installationId: target.installationId,
      installationDigest: target.installationDigest,
      programDigest: currentProgramDigest,
    }),
    async resolve(requested) {
      await options.onResolve?.();
      return {
        target: resolvedTarget ?? requested,
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
            (object) => typeof object["sentence"] === "string",
          ),
        async parseOutput(value) {
          await options.onParseOutput?.();
          return parseObject<Output & JsonValue>(
            value,
            (object) => typeof object["body"] === "string",
          );
        },
      };
    },
  };
  const journal =
    options.journal ?? new MemoryJournal(new TestIds("controller"));
  const clock = new TestClock(100);
  const capabilities = createControlCapabilities(
    {
      journal,
      policy: options.policy ?? allow,
      clock,
      executor: { owner: "executor-a" },
    },
    host,
    readerScope,
  );
  return {
    body: () => body,
    clock,
    contexts,
    capabilities,
    host,
    journal,
    driftProgram() {
      currentProgramDigest = digest("9");
    },
    resolveAs(value: ControlTarget) {
      resolvedTarget = value;
    },
  };
}

describe("host-neutral control capabilities", () => {
  it("recognizes and installs only a control-owned branded part", async () => {
    const value = fixture();
    const part = control({
      journal: value.journal,
      policy: allow,
      clock: value.clock,
      executor: { owner: "executor-installed" },
    });
    expect(isControlPart(part)).toBe(true);
    expect(isControlPart({ kind: "boundary.control" })).toBe(false);

    const installed = installControlPart(part, value.host, readerScope);
    await expect(
      installed.requester.request({
        actor: { id: "requester", session: "session" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      }),
    ).resolves.toMatchObject({
      version: 1,
      interactionId: target.interactionId,
      installationId: target.installationId,
      requestRealizationId: target.requestRealizationId,
    });
  });

  it("keeps authority phases atomic and context ephemeral by exact reference", async () => {
    const value = fixture();
    const requestContext: HostContext = {
      tenant: "tenant-a",
      capability: { token: "request-context-secret" },
    };
    const executionContext: HostContext = {
      tenant: "tenant-a",
      capability: { token: "execution-context-secret" },
    };
    const proposal = await value.capabilities.requester.request({
      actor: { id: "requester", session: "actor-secret" },
      context: requestContext,
      target,
      input: { body: "after" },
    });
    expect(value.contexts).toEqual([requestContext]);

    const approval = await value.capabilities.admin.approve(proposal, {
      id: "reviewer",
      session: "review-secret",
    });
    expect(approval.approvedBy).toBe("reviewer");
    expect(
      await value.journal.findGrantByProposalDigest(proposal.proposalDigest),
    ).toBeUndefined();
    expect(
      await value.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).toBeUndefined();

    const grant = await value.capabilities.admin.grant(proposal, {
      id: "issuer",
      session: "grant-secret",
    });
    expect(grant.issuedBy).toBe("issuer");
    expect(
      await value.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).toBeUndefined();

    await expect(
      value.capabilities.admin.execute(grant, executorActor, executionContext),
    ).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(value.body()).toBe("after");
    expect(value.contexts).toEqual([
      requestContext,
      executionContext,
      executionContext,
    ]);
    expect(value.contexts[0]).toBe(requestContext);
    expect(value.contexts[1]).toBe(executionContext);
    expect(value.contexts[2]).toBe(executionContext);

    const records = [
      proposal,
      await value.journal.getProposal(proposal.id),
      ...(await value.journal.listApprovals(proposal.proposalDigest)),
      grant,
      await value.journal.findAttemptByProposalDigest(proposal.proposalDigest),
      await value.journal.findReceiptByProposalDigest(proposal.proposalDigest),
    ];
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("request-context-secret");
    expect(serialized).not.toContain("execution-context-secret");
    expect(serialized).not.toContain("actor-secret");
    expect(serialized).not.toContain("review-secret");
    expect(serialized).not.toContain("grant-secret");
    for (const record of records) expect(record).not.toHaveProperty("context");
  });

  it.each(["approvedBy", "approvedAt"] as const)(
    "rejects a journal that substitutes approval %s",
    async (field) => {
      const value = fixture({ journal: new SubstitutingApprovalJournal(field) });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });

      await expect(
        value.capabilities.admin.approve(proposal, {
          id: "reviewer",
          session: "approve",
        }),
      ).rejects.toMatchObject({
        code: "CONTROL_JOURNAL_CONFLICT",
        path: `approval.substitute-${field}-approval-1`,
      });
    },
  );

  it.each(["approvedBy", "approvedAt"] as const)(
    "snapshots journal approval before deferred host resolution can mutate %s",
    async (field) => {
      const journal = new MutableApprovalJournal();
      const value = fixture({
        journal,
        async onResolve() {
          await Promise.resolve();
          journal.mutate(field);
        },
      });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });

      const approval = await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });

      expect(approval).toMatchObject({
        approvedBy: "reviewer",
        approvedAt: 100,
      });
      expect(Object.isFrozen(approval)).toBe(true);
    },
  );

  it.each(["approvedBy", "approvedAt"] as const)(
    "snapshots listed approvals before deferred grant policy can mutate %s",
    async (field) => {
      const journal = new MutableApprovalListJournal();
      let policyApprovals: readonly Approval[] | undefined;
      const policy: ControlPolicy<Actor> = {
        ...allow,
        async grant({ approvals }) {
          policyApprovals = approvals;
          await Promise.resolve();
          journal.mutate(field);
          await Promise.resolve();
          return { allow: true };
        },
      };
      const value = fixture({ journal, policy });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });

      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });

      expect(policyApprovals).toBeDefined();
      expect(Object.isFrozen(policyApprovals)).toBe(true);
      expect(Object.isFrozen(policyApprovals?.[0])).toBe(true);
      expect(policyApprovals?.[0]).toMatchObject({
        approvedBy: "reviewer",
        approvedAt: 100,
      });
      expect(grant.approvedBy).toEqual(["reviewer"]);
    },
  );

  it.each(["extra", "sparse"] as const)(
    "rejects a %s approval list at the journal read boundary",
    async (shape) => {
      const value = fixture({
        journal: new MalformedApprovalListJournal(shape),
      });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });

      await expect(
        value.capabilities.admin.grant(proposal, {
          id: "issuer",
          session: "grant",
        }),
      ).rejects.toMatchObject({
        code: "CONTROL_INTEGRITY_MISMATCH",
        path: "control.grant",
      });
    },
  );

  it.each(["record", "actor"] as const)(
    "rejects a duplicate approval %s before quorum policy",
    async (mode) => {
      const policy: ControlPolicy<Actor> = {
        ...allow,
        grant: ({ approvals }) =>
          approvals.length >= 2
            ? { allow: true }
            : { allow: false, reason: "two reviewers required" },
      };
      const value = fixture({
        journal: new DuplicateApprovalListJournal(mode),
        policy,
      });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });

      await expect(
        value.capabilities.admin.grant(proposal, {
          id: "issuer",
          session: "grant",
        }),
      ).rejects.toMatchObject({
        code: "CONTROL_INTEGRITY_MISMATCH",
        path: "control.grant",
      });
    },
  );

  it.each(["approve", "grant"] as const)(
    "rejects a journal that redirects a proposal string handle during %s",
    async (phase) => {
      const journal = new KeySubstitutingJournal();
      const value = fixture({ journal });
      const context: HostContext = {
        tenant: "tenant-a",
        capability: { token: "secret" },
      };
      const first = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request-a" },
        context,
        target,
        input: { body: "first" },
      });
      const second = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request-b" },
        context,
        target,
        input: { body: "second" },
      });
      if (phase === "grant") {
        await value.capabilities.admin.approve(first, {
          id: "reviewer-a",
          session: "approve-a",
        });
        await value.capabilities.admin.approve(second, {
          id: "reviewer-b",
          session: "approve-b",
        });
      }
      journal.proposalId = second.id;

      const interaction =
        phase === "approve"
          ? value.capabilities.admin.approve(first.id, {
              id: "reviewer",
              session: "approve",
            })
          : value.capabilities.admin.grant(first.id, {
              id: "issuer",
              session: "grant",
            });
      await expect(interaction).rejects.toMatchObject({
        code: "CONTROL_INTEGRITY_MISMATCH",
        path: `proposal.${first.id}`,
      });
    },
  );

  it("rejects a journal that redirects a grant string handle", async () => {
    const journal = new KeySubstitutingJournal();
    const value = fixture({ journal });
    const context: HostContext = {
      tenant: "tenant-a",
      capability: { token: "secret" },
    };
    const grants = [];
    for (const body of ["first", "second"]) {
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: body },
        context,
        target,
        input: { body },
      });
      await value.capabilities.admin.approve(proposal, {
        id: `reviewer-${body}`,
        session: body,
      });
      grants.push(
        await value.capabilities.admin.grant(proposal, {
          id: "issuer",
          session: body,
        }),
      );
    }
    journal.grantId = grants[1]!.id;

    await expect(
      value.capabilities.admin.execute(grants[0]!.id, executorActor, context),
    ).rejects.toMatchObject({
      code: "CONTROL_INTEGRITY_MISMATCH",
      path: `grant.${grants[0]!.id}`,
    });
    expect(value.body()).toBe("before");
  });

  it("rejects a journal that redirects an attempt string handle", async () => {
    const journal = new KeySubstitutingJournal();
    const value = fixture({ journal });
    const context: HostContext = {
      tenant: "tenant-a",
      capability: { token: "secret" },
    };
    const attempts: AttemptRecord[] = [];
    for (const body of ["first", "second"]) {
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: body },
        context,
        target,
        input: { body },
      });
      await value.capabilities.admin.approve(proposal, {
        id: `reviewer-${body}`,
        session: body,
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: body,
      });
      await value.capabilities.admin.execute(grant, executorActor, context);
      attempts.push(
        (await journal.findAttemptByProposalDigest(proposal.proposalDigest))!,
      );
    }
    journal.attemptId = attempts[1]!.id;

    await expect(
      value.capabilities.admin.reconcile(attempts[0]!.id, executorActor, context),
    ).rejects.toMatchObject({
      code: "CONTROL_INTEGRITY_MISMATCH",
      path: `attempt.${attempts[0]!.id}`,
    });
  });

  it("ignores a differently keyed attempt returned after a reconciliation CAS conflict", async () => {
    const journal = new KeySubstitutingJournal();
    const value = fixture({ journal, failAfterApply: true });
    const context: HostContext = {
      tenant: "tenant-a",
      capability: { token: "secret" },
    };
    const attempts: AttemptRecord[] = [];
    for (const body of ["first", "second"]) {
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: body },
        context,
        target,
        input: { body },
      });
      await value.capabilities.admin.approve(proposal, {
        id: `reviewer-${body}`,
        session: body,
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: body,
      });
      await expect(value.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
        status: "uncertain",
      });
      attempts.push(
        (await journal.findAttemptByProposalDigest(proposal.proposalDigest))!,
      );
    }
    value.clock.advance(30_001);
    journal.attemptId = attempts[1]!.id;
    journal.redirectAttemptAfterCas = true;

    await expect(
      value.capabilities.admin.reconcile(attempts[0]!.id, executorActor, context),
    ).resolves.toMatchObject({
      status: "uncertain",
      attempt: { id: attempts[0]!.id },
    });
  });

  it("rejects a journal-created proposal that differs from its candidate", async () => {
    const value = fixture({ journal: new SubstitutingProposalJournal() });

    await expect(
      value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_JOURNAL_CONFLICT",
    });
  });

  it.each(["id", "issuedAt"] as const)(
    "rejects a journal-created grant with substituted %s",
    async (field) => {
      const value = fixture({ journal: new SubstitutingGrantJournal(field) });
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });

      await expect(
        value.capabilities.admin.grant(proposal, {
          id: "issuer",
          session: "grant",
        }),
      ).rejects.toMatchObject({
        code: "CONTROL_JOURNAL_CONFLICT",
      });
    },
  );

  it("resumes an existing exact-authority grant without requiring candidate id or timestamp equality", async () => {
    const value = fixture();
    const proposal = await value.capabilities.requester.request({
      actor: { id: "requester", session: "request" },
      context: {
        tenant: "tenant-a",
        capability: { token: "secret" },
      },
      target,
      input: { body: "after" },
    });
    await value.capabilities.admin.approve(proposal, {
      id: "reviewer",
      session: "approve",
    });
    const first = await value.capabilities.admin.grant(proposal, {
      id: "issuer",
      session: "grant",
    });
    value.clock.advance(1);

    await expect(
      value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant-resume",
      }),
    ).resolves.toEqual(first);
  });

  it.each(["lease", "fence", "recordRevision", "execution"] as const)(
    "contains a journal-created attempt with substituted %s before apply",
    async (field) => {
      const value = fixture({ journal: new SubstitutingAttemptJournal(field) });
      const context: HostContext = {
        tenant: "tenant-a",
        capability: { token: "secret" },
      };
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context,
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });

      await expect(value.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
        status: "uncertain",
      });
      expect(value.body()).toBe("before");
    },
  );

  it.each(["id", "completedAt"] as const)(
    "contains a journal-created receipt with substituted %s",
    async (field) => {
      const value = fixture({
        journal: new ReceiptBoundaryJournal("substitute", field),
      });
      const context: HostContext = {
        tenant: "tenant-a",
        capability: { token: "secret" },
      };
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context,
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });

      await expect(value.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
        status: "uncertain",
      });
    },
  );

  it.each(["id", "completedAt"] as const)(
    "snapshots a created receipt before host resolution can mutate %s",
    async (field) => {
      const journal = new ReceiptBoundaryJournal("mutate", field);
      const value = fixture({
        journal,
        async onResolve() {
          await Promise.resolve();
          journal.mutate();
        },
      });
      const context: HostContext = {
        tenant: "tenant-a",
        capability: { token: "secret" },
      };
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context,
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });

      const result = await value.capabilities.admin.execute(grant, executorActor, context);
      expect(result).toMatchObject({
        status: "completed",
        receipt: {
          id: `receipt-mutate-${field}-receipt-1`,
          completedAt: 100,
        },
      });
    },
  );

  it.each([
    ["existing", "host"],
    ["existing", "parser"],
    ["recovered", "host"],
    ["recovered", "parser"],
  ] as const)(
    "snapshots and validates a %s receipt before deferred %s work",
    async (mode, trigger) => {
      const journal = new MutableReceiptReadJournal(mode === "recovered");
      const value = fixture({
        journal,
        async onResolve() {
          await Promise.resolve();
          if (trigger === "host") journal.mutate();
        },
        async onParseOutput() {
          await Promise.resolve();
          if (trigger === "parser") journal.mutate();
        },
      });
      const context: HostContext = {
        tenant: "tenant-a",
        capability: { token: "secret" },
      };
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context,
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });

      const first = await value.capabilities.admin.execute(grant, executorActor, context);
      if (mode === "existing") {
        expect(first.status).toBe("completed");
      } else {
        expect(first.status).toBe("completed");
      }
      const result =
        mode === "existing"
          ? await value.capabilities.admin.execute(grant, executorActor, context)
          : first;

      expect(result).toMatchObject({
        status: "completed",
        value: { body: "after" },
        receipt: {
          output: { body: "after" },
          evidence: { body: "after" },
        },
      });
    },
  );

  it("snapshots a completed attempt before crash-before-receipt replay awaits", async () => {
    const journal = new CrashBeforeReceiptJournal();
    const value = fixture({
      journal,
      async onResolve() {
        await Promise.resolve();
        journal.mutateAttempt();
      },
    });
    const context: HostContext = {
      tenant: "tenant-a",
      capability: { token: "secret" },
    };
    const proposal = await value.capabilities.requester.request({
      actor: { id: "requester", session: "request" },
      context,
      target,
      input: { body: "after" },
    });
    await value.capabilities.admin.approve(proposal, {
      id: "reviewer",
      session: "approve",
    });
    const grant = await value.capabilities.admin.grant(proposal, {
      id: "issuer",
      session: "grant",
    });

    await expect(value.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
      status: "uncertain",
    });
    journal.resume();

    await expect(value.capabilities.admin.execute(grant, executorActor, context)).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
      receipt: {
        output: { body: "after" },
        evidence: { body: "after" },
      },
    });
  });

  it("uses a fresh reconciliation context by exact reference without retrying apply", async () => {
    const value = fixture({ failAfterApply: true });
    const requestContext: HostContext = {
      tenant: "tenant-a",
      capability: { token: "request-secret" },
    };
    const executionContext: HostContext = {
      tenant: "tenant-a",
      capability: { token: "execution-secret" },
    };
    const reconciliationContext: HostContext = {
      tenant: "tenant-a",
      capability: { token: "reconciliation-secret" },
    };
    const proposal = await value.capabilities.requester.request({
      actor: { id: "requester", session: "session-secret" },
      context: requestContext,
      target,
      input: { body: "after" },
    });
    await value.capabilities.admin.approve(proposal, {
      id: "reviewer",
      session: "reviewer-secret",
    });
    const grant = await value.capabilities.admin.grant(proposal, {
      id: "issuer",
      session: "issuer-secret",
    });
    const first = await value.capabilities.admin.execute(grant, executorActor, executionContext);
    expect(first).toMatchObject({ status: "uncertain" });
    if (first.status !== "uncertain") throw new Error("expected uncertainty");
    expect(value.contexts).toEqual([requestContext, executionContext]);

    value.clock.advance(30_001);
    await expect(
      value.capabilities.admin.reconcile(first.attempt, executorActor, reconciliationContext),
    ).resolves.toMatchObject({
      status: "completed",
      value: { body: "after" },
    });
    expect(value.contexts).toEqual([
      requestContext,
      executionContext,
      reconciliationContext,
      reconciliationContext,
    ]);
    expect(value.contexts[2]).toBe(reconciliationContext);
    expect(value.contexts[3]).toBe(reconciliationContext);

    const serialized = JSON.stringify([
      await value.journal.getProposal(proposal.id),
      await value.journal.findAttemptByProposalDigest(proposal.proposalDigest),
      await value.journal.findReceiptByProposalDigest(proposal.proposalDigest),
    ]);
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("execution-secret");
    expect(serialized).not.toContain("reconciliation-secret");
  });

  it("rejects Program drift before an attempt or effect", async () => {
    const value = fixture();
    const context: HostContext = {
      tenant: "tenant-a",
      capability: { token: "secret" },
    };
    const proposal = await value.capabilities.requester.request({
      actor: { id: "requester", session: "request" },
      context,
      target,
      input: { body: "after" },
    });
    await value.capabilities.admin.approve(proposal, {
      id: "reviewer",
      session: "approve",
    });
    const grant = await value.capabilities.admin.grant(proposal, {
      id: "issuer",
      session: "grant",
    });
    value.driftProgram();

    await expect(value.capabilities.admin.execute(grant, executorActor, context)).rejects.toMatchObject({
      code: "CONTROL_INTEGRITY_MISMATCH",
    });
    expect(value.body()).toBe("before");
    expect(
      await value.journal.findAttemptByProposalDigest(proposal.proposalDigest),
    ).toBeUndefined();
  });

  it("rejects a host binding for a different exact target before planning", async () => {
    const value = fixture();
    value.resolveAs({ ...target, controlDigest: digest("8") });

    await expect(
      value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: {
          tenant: "tenant-a",
          capability: { token: "secret" },
        },
        target,
        input: { body: "after" },
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_INTEGRITY_MISMATCH",
      path: "control.request.target",
    });
    expect(value.contexts).toEqual([]);
    expect(await value.journal.getProposal("controller-proposal-1")).toBeUndefined();
    expect(value.body()).toBe("before");
  });

  it.each(["grant", "proposal"] as const)(
    "contains a %s reload failure after an attempt exists",
    async (fault) => {
      const journal = new RecoveryLookupFaultJournal(
        new TestIds(`controller-${fault}`),
      );
      const value = fixture({ failAfterApply: true, journal });
      const requestContext: HostContext = {
        tenant: "tenant-a",
        capability: { token: "request-secret" },
      };
      const executionContext: HostContext = {
        tenant: "tenant-a",
        capability: { token: "execution-secret" },
      };
      const proposal = await value.capabilities.requester.request({
        actor: { id: "requester", session: "request" },
        context: requestContext,
        target,
        input: { body: "after" },
      });
      await value.capabilities.admin.approve(proposal, {
        id: "reviewer",
        session: "approve",
      });
      const grant = await value.capabilities.admin.grant(proposal, {
        id: "issuer",
        session: "grant",
      });
      const first = await value.capabilities.admin.execute(grant, executorActor, executionContext);
      if (first.status !== "uncertain") throw new Error("expected uncertainty");

      value.clock.advance(30_001);
      journal.fault = fault;
      await expect(
        value.capabilities.admin.reconcile(first.attempt, executorActor, executionContext),
      ).resolves.toEqual(first);
      expect(value.body()).toBe("after");
    },
  );
});
