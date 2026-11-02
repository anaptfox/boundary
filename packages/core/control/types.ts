import type {
  JsonObject,
  JsonValue,
  Sha256Digest,
} from "@foxworth/boundary/program";

declare const proposalOutput: unique symbol;
declare const grantOutput: unique symbol;
declare const attemptOutput: unique symbol;
declare const controlPartActor: unique symbol;

export const CONTROL_RECORD_VERSION = 1 as const;

export type MaybePromise<Value> = Value | Promise<Value>;

/** Exact portable identity of one controlled interaction in one Program. */
export type ControlTarget = {
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
};

/** Identity repeated by every durable Control record. */
export type ControlRecordIdentity = ControlTarget;

export type ControlSubject = {
  readonly kind: string;
  readonly id: string;
};

/** Immutable observation authority for exact interactions in one host-chosen tenant. */
export type ControlReaderScope = Readonly<{
  readonly interactionIds: readonly string[];
  readonly tenant: ControlSubject;
}>;

export type ControlEffect = {
  readonly kind: string;
  readonly action: string;
  readonly resource: string;
  readonly description?: string;
  readonly details?: JsonObject;
};

/** Author-facing plan: state stays private while preview is safe to project. */
export type ControlPlan<
  State extends JsonValue = JsonValue,
  Preview extends JsonValue = JsonValue,
> = {
  readonly subject: ControlSubject;
  readonly baseline: JsonValue;
  readonly baselineSummary: string;
  readonly effects: readonly ControlEffect[];
  readonly state: State;
  readonly preview: Preview;
};

export type Verification =
  | { readonly ok: true; readonly evidence?: JsonValue }
  | {
      readonly ok: false;
      readonly message: string;
      readonly evidence?: JsonValue;
    };

export type Reconciliation<Output = unknown> =
  | { readonly status: "completed"; readonly value: Output }
  | { readonly status: "uncertain" }
  | { readonly status: "not-applied"; readonly reason: string };

export type LeaseSnapshot = {
  readonly owner: string;
  readonly expiresAt: number;
  readonly fence: number;
};

/** Live executor lease. Renewals are journal CAS interactions. */
export interface ControlLease {
  readonly owner: string;
  readonly expiresAt: number;
  readonly fence: number;
  renew(): Promise<LeaseSnapshot>;
}

export type PublicProposalContext<Preview extends JsonValue = JsonValue> = {
  readonly id: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly requestedBy: string;
  readonly subject: ControlSubject;
  readonly baselineSummary: string;
  readonly effects: readonly ControlEffect[];
  readonly preview: Preview;
  readonly createdAt: number;
};

export type ControlExecutionContext<
  Input = unknown,
  State extends JsonValue = JsonValue,
  Preview extends JsonValue = JsonValue,
  Context = unknown,
> = {
  readonly input: Input;
  readonly state: State;
  readonly proposal: PublicProposalContext<Preview>;
  readonly lease: ControlLease;
  readonly context: Context;
};

export interface ControlHook<
  Input = unknown,
  Output = unknown,
  State extends JsonValue = JsonValue,
  Preview extends JsonValue = JsonValue,
  StateSchema = unknown,
  PreviewSchema = unknown,
  Context = unknown,
> {
  /** Digest of the packaged executable artifact that supplies this behavior. */
  readonly realizationDigest: Sha256Digest;
  readonly state: StateSchema;
  readonly preview: PreviewSchema;
  plan(args: {
    readonly input: Input;
    readonly context: Context;
  }): MaybePromise<ControlPlan<State, Preview>>;
  apply(
    args: ControlExecutionContext<Input, State, Preview, Context>,
  ): MaybePromise<Output>;
  verify(
    args: ControlExecutionContext<Input, State, Preview, Context> & {
      readonly output: Output;
    },
  ): MaybePromise<Verification>;
  reconcile(
    args: ControlExecutionContext<Input, State, Preview, Context>,
  ): MaybePromise<Reconciliation<Output>>;
}

export type AnyControlHook<Context = unknown> = ControlHook<
  unknown,
  unknown,
  JsonValue,
  JsonValue,
  unknown,
  unknown,
  Context
>;

export type ControlHookPreview<Value> =
  Value extends ControlHook<any, any, any, infer Preview, any, any, any>
    ? Preview
    : JsonValue;

export type ControlHookOutput<Value> =
  Value extends ControlHook<any, infer Output, any, any, any, any, any>
    ? Output
    : unknown;

/** A host-owned, snapshotted controlled realization for one exact target. */
export type ControlBinding<Context = unknown> = {
  readonly target: ControlTarget;
  readonly hook: AnyControlHook<Context>;
  parseInput(value: unknown): MaybePromise<unknown>;
  parseState(value: unknown): MaybePromise<unknown>;
  parsePreview(value: unknown): MaybePromise<unknown>;
  parseOutput(value: unknown): MaybePromise<unknown>;
};

/** Narrow host seam. Runtime data, dispatch, and schema ownership stay outside control. */
export interface ControlHost<Context = unknown> {
  inspect(): MaybePromise<{
    readonly installationId: string;
    readonly installationDigest: Sha256Digest;
    readonly programDigest: Sha256Digest;
  }>;
  resolve(target: ControlTarget): MaybePromise<ControlBinding<Context>>;
}

export type Proposal<
  Preview extends JsonValue = JsonValue,
  Output = unknown,
> = PublicProposalContext<Preview> & {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly [proposalOutput]?: Output;
};

/** The exact portable proposal shape allowed to cross a review boundary. */
export type PublicProposal<
  Preview extends JsonValue = JsonValue,
  Output = unknown,
> = Proposal<Preview, Output>;

export type ProposalOutput<Value> =
  Value extends Proposal<JsonValue, infer Output> ? Output : unknown;

/** Durable private proposal. Journal/projector implementations must not expose state. */
export type ProposalRecord<Preview extends JsonValue = JsonValue> =
  Proposal<Preview, unknown> & {
    readonly input: JsonValue;
    readonly baseline: JsonValue;
    readonly state: JsonValue;
  };

export type Approval<Preview extends JsonValue = JsonValue> = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly proposalId: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly approvedBy: string;
  readonly approvedAt: number;
  readonly preview: Preview;
};

export type Grant<
  Preview extends JsonValue = JsonValue,
  Output = unknown,
> = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly proposalId: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly requestedBy: string;
  readonly approvedBy: readonly string[];
  readonly subject: ControlSubject;
  readonly preview: Preview;
  readonly issuedBy: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
  readonly [grantOutput]?: Output;
};

export type GrantOutput<Value> =
  Value extends Grant<JsonValue, infer Output> ? Output : unknown;

export type AttemptExecution =
  | "started"
  | "uncertain"
  | "not-applied"
  | "completed";

export type AttemptVerification = "pending" | "verified" | "failed";

export type AttemptRecord = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly recordRevision: number;
  readonly proposalId: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly grantId: string;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly execution: AttemptExecution;
  readonly verification: AttemptVerification;
  readonly lease: LeaseSnapshot;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly output?: JsonValue;
  readonly evidence?: JsonValue;
  readonly message?: string;
};

/** Structural identity accepted from durable or decoded attempt references. */
export type UntypedAttemptRef = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly proposalId: string;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly controlDigest: Sha256Digest;
};

/** Required private output relation, minted by Control and erased at runtime. */
export type AttemptRef<Output = unknown> = UntypedAttemptRef & {
  readonly [attemptOutput]: Output;
};

export type AttemptOutput<Value> =
  Value extends AttemptRef<infer Output> ? Output : unknown;

export type ReceiptRecord = {
  readonly version: typeof CONTROL_RECORD_VERSION;
  readonly id: string;
  readonly attemptId: string;
  readonly proposalId: string;
  readonly proposalDigest: Sha256Digest;
  readonly bindingDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly installationId: string;
  readonly installationDigest: Sha256Digest;
  readonly expectedProgramDigest: Sha256Digest;
  readonly actualProgramDigest: Sha256Digest;
  readonly programDigest: Sha256Digest;
  readonly grantId: string;
  readonly controlDigest: Sha256Digest;
  readonly interactionId: string;
  readonly expectedContractDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly requestRealizationId: string;
  readonly executionRealizationId: string;
  readonly controlRealizationDigest: Sha256Digest;
  readonly output: JsonValue;
  readonly evidence?: JsonValue;
  readonly completedAt: number;
};

/** Public proof of a completed, verified effect. */
export type Receipt = ReceiptRecord;

/** Public explanation for a proven non-application. */
export type NotAppliedReason = string;

export type CreateRecordResult<RecordValue> =
  | { readonly kind: "created"; readonly record: RecordValue }
  | { readonly kind: "existing"; readonly record: RecordValue };

export type ControlRecordKind =
  | "proposal"
  | "approval"
  | "grant"
  | "attempt"
  | "receipt";

/** Native storage query; filtering is an optimization, never reader authority. */
export type ControlPageQuery = Readonly<{
  limit: number;
  afterId?: string;
  interactionId?: string;
}>;
export type ControlPage<Status> = Readonly<{
  items: readonly Status[];
  nextAfterId?: string;
}>;
export type ControlJournalQuery = ControlPageQuery & Readonly<{ scope: ControlReaderScope }>;
export type ControlStatusChain = Readonly<{
  proposalDigest: Sha256Digest;
  grant?: Grant;
  attempt?: AttemptRecord;
  receipt?: ReceiptRecord;
}>;

export interface ControlJournal {
  nextId(kind: ControlRecordKind): MaybePromise<string>;

  /** Return at most limit rows, strictly increasing by UTF-8 id, after afterId. */
  queryProposals?(query: ControlJournalQuery): Promise<readonly ProposalRecord[]>;
  /** One entry per requested digest, in the same order; no public redaction here. */
  readStatusChains?(digests: readonly Sha256Digest[]): Promise<readonly ControlStatusChain[]>;

  createProposal(
    proposal: ProposalRecord,
  ): Promise<CreateRecordResult<ProposalRecord>>;
  getProposal(id: string): Promise<ProposalRecord | undefined>;
  findProposalByDigest(
    digest: Sha256Digest,
  ): Promise<ProposalRecord | undefined>;
  listProposals(): Promise<readonly ProposalRecord[]>;

  createApproval(
    approval: Approval,
  ): Promise<CreateRecordResult<Approval>>;
  getApproval(id: string): Promise<Approval | undefined>;
  listApprovals(proposalDigest: Sha256Digest): Promise<readonly Approval[]>;

  createGrant(grant: Grant): Promise<CreateRecordResult<Grant>>;
  getGrant(id: string): Promise<Grant | undefined>;
  findGrantByProposalDigest(
    digest: Sha256Digest,
  ): Promise<Grant | undefined>;

  createAttempt(
    attempt: AttemptRecord,
  ): Promise<CreateRecordResult<AttemptRecord>>;
  compareAndSwapAttempt(
    attempt: AttemptRecord,
    expectedRecordRevision: number,
  ): Promise<boolean>;
  getAttempt(id: string): Promise<AttemptRecord | undefined>;
  findAttemptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<AttemptRecord | undefined>;

  createReceipt(
    receipt: ReceiptRecord,
  ): Promise<CreateRecordResult<ReceiptRecord>>;
  getReceipt(id: string): Promise<ReceiptRecord | undefined>;
  findReceiptByProposalDigest(
    digest: Sha256Digest,
  ): Promise<ReceiptRecord | undefined>;
}

export interface ControlClock {
  now(): number;
}

export type ControlExecutor = {
  readonly owner: string;
};

export type LeaseOptions = {
  readonly durationMs: number;
};

export type ControlDecision =
  | { readonly allow: true; readonly expiresAt?: number }
  | { readonly allow: false; readonly reason: string };

export interface ControlPolicy<Actor = string> {
  identify(actor: Actor): string;
  request(args: {
    readonly actor: Actor;
    readonly proposal: ProposalRecord;
  }): MaybePromise<ControlDecision>;
  approve(args: {
    readonly actor: Actor;
    readonly proposal: ProposalRecord;
  }): MaybePromise<ControlDecision>;
  grant(args: {
    readonly actor: Actor;
    readonly proposal: ProposalRecord;
    readonly approvals: readonly Approval[];
  }): MaybePromise<ControlDecision>;
  execute(args: {
    readonly actor: Actor;
    readonly proposal: ProposalRecord;
    readonly grant: Grant;
  }): MaybePromise<ControlDecision>;
  reconcile(args: {
    readonly actor: Actor;
    readonly proposal: ProposalRecord;
    readonly grant: Grant;
    readonly attempt: AttemptRecord;
  }): MaybePromise<ControlDecision>;
  preflight(args: {
    readonly proposal: ProposalRecord;
    readonly grant: Grant;
  }): MaybePromise<void>;
}

export type EffectResult<Output = unknown> =
  | {
      readonly status: "completed";
      readonly value: Output;
      readonly receipt: Receipt;
    }
  | {
      readonly status: "uncertain";
      readonly attempt: AttemptRef<Output>;
    }
  | {
      readonly status: "not-applied";
      readonly reason: NotAppliedReason;
    };

export type ControlOptions<Actor> = {
  readonly journal: ControlJournal;
  readonly policy: ControlPolicy<Actor>;
  readonly clock: ControlClock;
  readonly executor: ControlExecutor;
  readonly lease?: LeaseOptions;
};

export type ControlRequest<Actor, Context> = {
  readonly actor: Actor;
  readonly context: Context;
  readonly target: ControlTarget;
  readonly input: unknown;
};

/** Atomic control phases over one host-neutral interaction binding. */
/** Proposal-creation authority used by request-mode Host contributions. */
export interface ControlRequester<Actor, Context = unknown> {
  request<Preview extends JsonValue = JsonValue, Output = unknown>(
    request: ControlRequest<Actor, Context>,
  ): Promise<Proposal<Preview, Output>>;
}

export type ControlRecord =
  | Proposal
  | Approval
  | Grant
  | AttemptRef
  | ReceiptRecord;

export type ControlRecordRef = Readonly<{
  kind: ControlRecordKind;
  id: string;
}>;

export interface ControlReader<Status = unknown, Query = unknown> {
  get(reference: ControlRecordRef): Promise<ControlRecord | undefined>;
  status(reference: Proposal | string): Promise<Status>;
  list(query?: Query): Promise<readonly Status[]>;
  page(query: ControlPageQuery): Promise<ControlPage<Status>>;
}

/** Administrative authority. Observation and proposal creation are absent. */
export interface ControlAdmin<Actor, Context = unknown> {

  approve<Preview extends JsonValue, Output>(
    proposal: Proposal<Preview, Output>,
    actor: Actor,
  ): Promise<Approval<Preview>>;
  approve(proposalId: string, actor: Actor): Promise<Approval>;

  grant<Preview extends JsonValue, Output>(
    proposal: Proposal<Preview, Output>,
    actor: Actor,
  ): Promise<Grant<Preview, Output>>;
  grant(proposalId: string, actor: Actor): Promise<Grant>;

  execute<Value extends Grant>(
    grant: Value,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult<GrantOutput<Value>>>;
  execute(
    grantId: string,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult>;

  reconcile<Value extends AttemptRef>(
    attempt: Value,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult<AttemptOutput<Value>>>;
  reconcile(
    attempt: UntypedAttemptRef | string,
    actor: Actor,
    context: Context,
  ): Promise<EffectResult>;
}

export interface ControlCapabilities<Actor, Context, Status = unknown, Query = unknown> {
  readonly requester: ControlRequester<Actor, Context>;
  readonly reader: ControlReader<Status, Query>;
  readonly admin: ControlAdmin<Actor, Context>;
}

/** Branded app part. Options remain private in the control-owned WeakMap. */
export type ControlPart<Actor = string> = {
  readonly kind: "boundary.control";
  readonly [controlPartActor]?: (actor: Actor) => Actor;
};

export type ControlPartActor<Value> =
  Value extends ControlPart<infer Actor> ? Actor : never;
