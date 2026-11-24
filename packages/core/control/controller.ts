import {
  ControlError,
  controlError,
  type ControlDiagnosticCode,
} from "./errors";
import {
  approveControl,
  executeControl,
  grantControl,
  reconcileControl,
  requestControl,
  type ControlRuntime,
} from "./kernel";
import { listControl, pageControl, statusControl } from "./kernel-status";
import {
  approvalMatchesProposal,
  attemptMatches,
  grantMatchesProposal,
  publicAttempt,
  publicProposal,
  receiptMatches,
  requireValidProposal,
  snapshotAttemptRecord,
  snapshotReceiptRecord,
} from "./records";
import { snapshotApprovalRecord } from "./approval-records";
import type {
  ControlListFilter,
  PublicControlStatus,
} from "./interaction-schemas";
import { publicGrant, snapshotGrantRecord } from "./interaction-schemas";
import {
  controlReaderScopeIncludes,
  controlRecordProposalId,
  snapshotControlReaderScope,
} from "./reader-scope";
import type {
  UntypedAttemptRef,
  ControlAdmin,
  ControlCapabilities,
  ControlHost,
  ControlOptions,
  ControlPart,
  ControlReader,
  ControlRecord,
  ControlRecordRef,
  ControlRequester,
  ControlReaderScope,
  ControlRequest,
  Grant,
  Proposal,
} from "./types";

const controlOptions = new WeakMap<object, ControlOptions<unknown>>();
// Authenticity is deliberately scoped to one loaded Control module instance.
// A global registry would make duplicate copies interoperate, but it would
// also give arbitrary same-process code a forgeable registration channel.
// Duplicate package instances therefore fail closed at the bridge boundary.
const controlRequesters = new WeakMap<
  object,
  ControlRequester<unknown, unknown>["request"]
>();

function assertOptions<Actor>(options: ControlOptions<Actor>): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("control options are required");
  }
  if (!options.journal || typeof options.journal !== "object") {
    throw new TypeError("control journal is required");
  }
  if (!options.policy || typeof options.policy !== "object") {
    throw new TypeError("control policy is required");
  }
  if (!options.clock || typeof options.clock.now !== "function") {
    throw new TypeError("control clock is required");
  }
  if (!options.executor?.owner?.trim()) {
    throw new TypeError("control executor owner is required");
  }
}

function assertHost<Context>(host: ControlHost<Context>): void {
  if (!host || typeof host !== "object") {
    throw new TypeError("control host is required");
  }
  if (typeof host.inspect !== "function") {
    throw new TypeError("control host inspect is required");
  }
  if (typeof host.resolve !== "function") {
    throw new TypeError("control host resolve is required");
  }
}

async function publicControlAction<Value>(
  code: ControlDiagnosticCode,
  path: string,
  action: () => Promise<Value>,
): Promise<Value> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw controlError(
      code,
      path,
      error instanceof Error ? error.message : "control action failed",
      error,
    );
  }
}

function runtimeFor<Actor, Context>(
  options: ControlOptions<Actor>,
  host: ControlHost<Context>,
): ControlRuntime<Actor, Context> {
  assertOptions(options);
  assertHost(host);
  return Object.freeze({ ...options, host });
}

export function createControlRequester<Actor, Context>(
  options: ControlOptions<Actor>,
  host: ControlHost<Context>,
): ControlRequester<Actor, Context> {
  const runtime = runtimeFor(options, host);
  const request = ((value: ControlRequest<Actor, Context>) =>
    publicControlAction(
      "CONTROL_INVALID_REALIZATION",
      "control.request",
      () => requestControl(runtime, value),
    )) as ControlRequester<Actor, Context>["request"];
  const requester = Object.freeze({ request });
  controlRequesters.set(
    requester,
    request as ControlRequester<unknown, unknown>["request"],
  );
  return requester;
}

/** @internal Authenticate and snapshot proposal-creation authority. */
export function requestForControlRequester<Actor, Context>(
  requester: ControlRequester<Actor, Context>,
): ControlRequester<Actor, Context>["request"] {
  if (!requester || typeof requester !== "object") {
    throw new TypeError("an authentic ControlRequester is required");
  }
  const request = controlRequesters.get(requester);
  if (!request) {
    throw new TypeError("an authentic ControlRequester is required");
  }
  return request as ControlRequester<Actor, Context>["request"];
}

export function createControlAdmin<Actor, Context>(
  options: ControlOptions<Actor>,
  host: ControlHost<Context>,
): ControlAdmin<Actor, Context> {
  const runtime = runtimeFor(options, host);
  const approve = ((proposal: Proposal | string, actor: Actor) =>
    publicControlAction(
      "CONTROL_INVALID_RECORD",
      "control.approve",
      () => approveControl(runtime, actor, proposal),
    )) as ControlAdmin<Actor, Context>["approve"];
  const grant = ((proposal: Proposal | string, actor: Actor) =>
    publicControlAction(
      "CONTROL_INVALID_RECORD",
      "control.grant",
      () => grantControl(runtime, actor, proposal),
    )) as ControlAdmin<Actor, Context>["grant"];
  const execute = ((grantValue: Grant | string, actor: Actor, context: Context) =>
    publicControlAction(
      "CONTROL_INVALID_RECORD",
      "control.execute",
      () => executeControl(runtime, grantValue, actor, context),
    )) as ControlAdmin<Actor, Context>["execute"];
  const reconcile = ((
    attempt: UntypedAttemptRef | string,
    actor: Actor,
    context: Context,
  ) =>
    publicControlAction(
      "CONTROL_INVALID_RECORD",
      "control.reconcile",
      () => reconcileControl(runtime, attempt, actor, context),
    )) as ControlAdmin<Actor, Context>["reconcile"];
  return Object.freeze({ approve, grant, execute, reconcile });
}

async function getRecord(
  options: Pick<ControlOptions<unknown>, "journal">,
  scope: ControlReaderScope,
  reference: ControlRecordRef,
): Promise<ControlRecord | undefined> {
  if (!reference || typeof reference !== "object" || !reference.id?.trim()) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "control.reader.reference",
      "record reference requires a kind and non-empty id",
    );
  }
  const requireRequestedId = (actual: string, path: string): void => {
    if (actual !== reference.id) {
      throw controlError(
        "CONTROL_INTEGRITY_MISMATCH",
        path,
        "journal record id does not match its requested key",
      );
    }
  };
  const proposalFor = async (value: unknown) => {
    const proposalId = controlRecordProposalId(value);
    if (proposalId === undefined) return undefined;
    const record = await options.journal.getProposal(proposalId);
    if (
      record === undefined ||
      !controlReaderScopeIncludes(scope, record)
    ) {
      return undefined;
    }
    return requireValidProposal(record);
  };
  switch (reference.kind) {
    case "proposal": {
      const record = await options.journal.getProposal(reference.id);
      if (record === undefined) return undefined;
      if (!controlReaderScopeIncludes(scope, record)) return undefined;
      const proposal = requireValidProposal(record);
      requireRequestedId(proposal.id, "control.reader.proposal.id");
      return publicProposal(proposal);
    }
    case "approval": {
      const raw = await options.journal.getApproval(reference.id);
      if (raw === undefined) return undefined;
      const proposal = await proposalFor(raw);
      if (proposal === undefined) return undefined;
      const approval = snapshotApprovalRecord(raw);
      requireRequestedId(approval.id, "control.reader.approval.id");
      if (!approvalMatchesProposal(approval, proposal)) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.approval",
          "approval does not match the exact proposal identity",
        );
      }
      return approval;
    }
    case "grant": {
      const raw = await options.journal.getGrant(reference.id);
      if (raw === undefined) return undefined;
      const proposal = await proposalFor(raw);
      if (proposal === undefined) return undefined;
      const grant = snapshotGrantRecord(raw);
      requireRequestedId(grant.id, "control.reader.grant.id");
      if (!grantMatchesProposal(grant, proposal)) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.grant",
          "grant does not match the exact proposal identity",
        );
      }
      return publicGrant(grant) as Grant;
    }
    case "attempt": {
      const raw = await options.journal.getAttempt(reference.id);
      if (raw === undefined) return undefined;
      const proposal = await proposalFor(raw);
      if (proposal === undefined) return undefined;
      const attempt = snapshotAttemptRecord(raw);
      requireRequestedId(attempt.id, "control.reader.attempt.id");
      const rawGrant = await options.journal.getGrant(attempt.grantId);
      if (rawGrant === undefined) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.attempt",
          "attempt references a missing proposal or grant",
        );
      }
      const grant = snapshotGrantRecord(rawGrant);
      if (
        !grantMatchesProposal(grant, proposal) ||
        !attemptMatches(attempt, proposal, grant)
      ) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.attempt",
          "attempt does not match the exact proposal and grant identity",
        );
      }
      return publicAttempt(attempt);
    }
    case "receipt": {
      const raw = await options.journal.getReceipt(reference.id);
      if (raw === undefined) return undefined;
      const proposal = await proposalFor(raw);
      if (proposal === undefined) return undefined;
      const receipt = snapshotReceiptRecord(raw);
      requireRequestedId(receipt.id, "control.reader.receipt.id");
      const [rawGrant, rawAttempt] = await Promise.all([
        options.journal.getGrant(receipt.grantId),
        options.journal.getAttempt(receipt.attemptId),
      ]);
      if (
        rawGrant === undefined ||
        rawAttempt === undefined
      ) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.receipt",
          "receipt references a missing proposal, grant, or attempt",
        );
      }
      const grant = snapshotGrantRecord(rawGrant);
      const attempt = snapshotAttemptRecord(rawAttempt);
      if (
        !grantMatchesProposal(grant, proposal) ||
        !attemptMatches(attempt, proposal, grant) ||
        !receiptMatches(receipt, attempt, proposal, grant)
      ) {
        throw controlError(
          "CONTROL_INTEGRITY_MISMATCH",
          "control.reader.receipt",
          "receipt does not match the exact completed proposal chain",
        );
      }
      return receipt;
    }
    default:
      throw controlError(
        "CONTROL_INVALID_RECORD",
        "control.reader.reference.kind",
        "record kind is invalid",
      );
  }
}

export function createControlReader(
  options: Pick<ControlOptions<unknown>, "journal">,
  scopeValue: ControlReaderScope,
): ControlReader<PublicControlStatus, ControlListFilter> {
  if (!options?.journal || typeof options.journal !== "object") {
    throw new TypeError("control journal is required");
  }
  const scope = snapshotControlReaderScope(scopeValue);
  return Object.freeze({
    get(reference: ControlRecordRef) {
      return publicControlAction(
        "CONTROL_INVALID_RECORD",
        "control.reader.get",
        () => getRecord(options, scope, reference),
      );
    },
    status(reference: Proposal | string) {
      const proposalId = typeof reference === "string" ? reference : reference.id;
      return publicControlAction(
        "CONTROL_INVALID_RECORD",
        "control.reader.status",
        () => statusControl(options.journal, proposalId, scope),
      );
    },
    page(query: import("./types").ControlPageQuery) {
      return publicControlAction("CONTROL_INVALID_RECORD", "control.reader.page",
        () => pageControl(options.journal, query, scope));
    },
    list(query?: ControlListFilter) {
      return publicControlAction(
        "CONTROL_INVALID_RECORD",
        "control.reader.list",
        () => listControl(options.journal, query, scope),
      );
    },
  });
}

export function createControlCapabilities<Actor, Context>(
  options: ControlOptions<Actor>,
  host: ControlHost<Context>,
  readerScope: ControlReaderScope,
): ControlCapabilities<
  Actor,
  Context,
  PublicControlStatus,
  ControlListFilter
> {
  return Object.freeze({
    requester: createControlRequester(options, host),
    reader: createControlReader(
      options as ControlOptions<unknown>,
      readerScope,
    ),
    admin: createControlAdmin(options, host),
  });
}

/** Configure Control without importing or assuming an application model. */
export function control<Actor = string>(
  options: ControlOptions<Actor>,
): ControlPart<Actor> {
  assertOptions(options);
  const part: ControlPart<Actor> = Object.freeze({ kind: "boundary.control" });
  controlOptions.set(part, options as ControlOptions<unknown>);
  return part;
}

export function isControlPart(value: unknown): value is ControlPart<unknown> {
  return value !== null && typeof value === "object" && controlOptions.has(value);
}

export function controlPartOptions<Actor>(
  part: ControlPart<Actor>,
): ControlOptions<Actor> {
  const options = controlOptions.get(part);
  if (!options) throw new TypeError("unknown control part");
  return options as ControlOptions<Actor>;
}

export function installControlPart<Actor, Context>(
  part: ControlPart<Actor>,
  host: ControlHost<Context>,
  readerScope: ControlReaderScope,
): ControlCapabilities<Actor, Context, PublicControlStatus, ControlListFilter> {
  const options = controlOptions.get(part);
  if (!options) throw new TypeError("unknown control part");
  return createControlCapabilities(
    options as ControlOptions<Actor>,
    host,
    readerScope,
  );
}
