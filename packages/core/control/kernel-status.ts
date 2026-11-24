import { cloneJson, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { controlError } from "./errors";
import {
  publicGrant,
  snapshotGrantRecord,
  type ControlListFilter,
  type PublicControlStatus,
} from "./interaction-schemas";
import {
  attemptMatches,
  grantMatchesProposal,
  publicAttempt,
  publicProposal,
  receiptMatches,
  requireValidProposal,
  snapshotAttemptRecord,
  snapshotReceiptRecord,
} from "./records";
import {
  controlReaderScopeIncludes,
  snapshotControlReaderScope,
} from "./reader-scope";
import type { ControlJournal, ControlReaderScope, ControlPageQuery, ControlPage, ControlStatusChain } from "./types";

function invalidStatus(path: string, message: string): never {
  throw controlError("CONTROL_INTEGRITY_MISMATCH", path, message);
}

export async function statusControl(
  journal: ControlJournal,
  proposalId: string,
  scopeValue: ControlReaderScope,
): Promise<PublicControlStatus> {
  const scope = snapshotControlReaderScope(scopeValue);
  const rawProposal = await journal.getProposal(proposalId);
  if (!rawProposal || !controlReaderScopeIncludes(scope, rawProposal)) {
    throw controlError(
      "CONTROL_UNKNOWN_PROPOSAL",
      "control.reader.status",
      "proposal was not found",
    );
  }
  const proposal = requireValidProposal(rawProposal);
  if (proposal.id !== proposalId) {
    invalidStatus(
      "status.proposal.id",
      "journal proposal id does not match its requested key",
    );
  }
  return statusForValidatedProposal(journal, proposal);
}

async function statusForValidatedProposal(
  journal: ControlJournal,
  proposal: Awaited<ReturnType<typeof requireValidProposal>>,
): Promise<PublicControlStatus> {
  const [rawGrant, rawAttempt, rawReceipt] = await Promise.all([
    journal.findGrantByProposalDigest(proposal.proposalDigest),
    journal.findAttemptByProposalDigest(proposal.proposalDigest),
    journal.findReceiptByProposalDigest(proposal.proposalDigest),
  ]);
  return statusFromChain(proposal, { proposalDigest: proposal.proposalDigest,
    ...(rawGrant === undefined ? {} : { grant: rawGrant }),
    ...(rawAttempt === undefined ? {} : { attempt: rawAttempt }),
    ...(rawReceipt === undefined ? {} : { receipt: rawReceipt }) });
}

function statusFromChain(
  proposal: Awaited<ReturnType<typeof requireValidProposal>>,
  chain: ControlStatusChain,
): PublicControlStatus {
  if (chain.proposalDigest !== proposal.proposalDigest) invalidStatus("status.chain", "batch key mismatch");
  const { grant: rawGrant, attempt: rawAttempt, receipt: rawReceipt } = chain;
  const grant = rawGrant === undefined
    ? undefined
    : snapshotGrantRecord(rawGrant, "status.grant");
  if (grant && !grantMatchesProposal(grant, proposal)) {
    invalidStatus("status.grant", "grant does not match the exact proposal identity");
  }
  const attempt = rawAttempt === undefined
    ? undefined
    : snapshotAttemptRecord(rawAttempt);
  if (attempt && (!grant || !attemptMatches(attempt, proposal, grant))) {
    invalidStatus("status.attempt", "attempt does not match an exact proposal and grant");
  }
  const receipt = rawReceipt === undefined
    ? undefined
    : snapshotReceiptRecord(rawReceipt, "status.receipt");
  if (
    receipt &&
    (!grant || !attempt || !receiptMatches(receipt, attempt, proposal, grant))
  ) {
    invalidStatus(
      "status.receipt",
      "receipt does not match an exact completed and verified attempt",
    );
  }
  return Object.freeze({
    proposal: publicProposal(proposal),
    ...(grant === undefined ? {} : { grant: publicGrant(grant) }),
    ...(attempt === undefined ? {} : { attempt: publicAttempt(attempt) }),
    ...(receipt === undefined ? {} : { receipt }),
  });
}

export async function listControl(
  journal: ControlJournal,
  filter: ControlListFilter | undefined,
  scopeValue: ControlReaderScope,
): Promise<readonly PublicControlStatus[]> {
  const scope = snapshotControlReaderScope(scopeValue);
  const found = filter?.proposalId === undefined ? undefined : await journal.getProposal(filter.proposalId);
  if (found && found.id !== filter?.proposalId) invalidStatus("list.proposal.id", "journal key mismatch");
  const rawProposals = filter?.proposalId === undefined
    ? await journal.listProposals() : found === undefined ? [] : [found];
  if (!Array.isArray(rawProposals)) {
    throw controlError(
      "CONTROL_INVALID_RECORD",
      "control.list",
      "proposal list must be an array",
    );
  }
  const proposals = await Promise.all(
    rawProposals
      .filter((proposal) => controlReaderScopeIncludes(scope, proposal))
      .map((proposal) => requireValidProposal(proposal)),
  );
  const selected = proposals.filter((proposal) => {
    if (filter?.proposalId !== undefined && proposal.id !== filter.proposalId) {
      return false;
    }
    if (
      filter?.interactionId !== undefined &&
      proposal.interactionId !== filter.interactionId
    ) {
      return false;
    }
    return true;
  });
  selected.sort((left, right) => compareUtf8(left.id, right.id));
  const statuses: PublicControlStatus[] = [];
  for (let offset = 0; offset < selected.length; offset += 16) {
    const batch = selected.slice(offset, offset + 16);
    if (journal.readStatusChains) {
      const chains = await journal.readStatusChains(batch.map((proposal) => proposal.proposalDigest));
      if (!Array.isArray(chains) || chains.length !== batch.length) {
        invalidStatus("list.chains", "batch length mismatch");
      }
      statuses.push(...batch.map((proposal, index) => {
        const chain = chains[index];
        if (!chain || typeof chain !== "object" || Array.isArray(chain)) {
          invalidStatus("list.chains", "batch entry must be an object");
        }
        return statusFromChain(proposal, chain);
      }));
    } else {
      statuses.push(...await Promise.all(batch
        .map((proposal) => statusForValidatedProposal(journal, proposal))));
    }
  }
  return Object.freeze(statuses);
}

/** Bounded native reader query. A cursor is an exclusive id, not a snapshot token. */
export async function pageControl(
  journal: ControlJournal,
  query: ControlPageQuery,
  scopeValue: ControlReaderScope,
): Promise<ControlPage<PublicControlStatus>> {
  const scope = snapshotControlReaderScope(scopeValue);
  query = cloneJson(query as unknown as JsonValue, "control.page.query") as unknown as ControlPageQuery;
  if (!query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some((key) => !["limit", "afterId", "interactionId"].includes(key))) {
    throw controlError("CONTROL_INVALID_RECORD", "control.page.query", "query must contain only limit, afterId and interactionId");
  }
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 ||
      (query.afterId !== undefined && typeof query.afterId !== "string") ||
      (query.interactionId !== undefined && typeof query.interactionId !== "string")) {
    throw controlError("CONTROL_INVALID_RECORD", "control.page", "limit must be 1..100 and cursor must be a string");
  }
  if (!journal.queryProposals || !journal.readStatusChains) {
    throw controlError("CONTROL_NOT_CONFIGURED", "control.page", "journal must support bounded queries and batch reads");
  }
  if (query.interactionId !== undefined && !scope.interactionIds.includes(query.interactionId)) {
    return Object.freeze({ items: Object.freeze([]) });
  }
  const rows = await journal.queryProposals(Object.freeze({ ...query, scope, limit: query.limit + 1 }));
  if (!Array.isArray(rows) || rows.length > query.limit + 1) invalidStatus("page.rows", "journal exceeded page bound");
  let previous = query.afterId;
  const proposals = [];
  for (const row of rows) {
    if (!controlReaderScopeIncludes(scope, row) ||
        (query.interactionId !== undefined && row.interactionId !== query.interactionId)) {
      invalidStatus("page.scope", "journal returned a row outside requested scope");
    }
    const proposal = requireValidProposal(row);
    if (previous !== undefined && compareUtf8(previous, proposal.id) >= 0) invalidStatus("page.cursor", "journal rows must strictly advance cursor");
    previous = proposal.id;
    proposals.push(proposal);
  }
  const selected = proposals.slice(0, query.limit);
  const chains = await journal.readStatusChains(selected.map((proposal) => proposal.proposalDigest));
  if (!Array.isArray(chains) || chains.length !== selected.length) invalidStatus("page.chains", "batch length mismatch");
  const items = Object.freeze(selected.map((proposal, index) => statusFromChain(proposal, chains[index]!)));
  return Object.freeze({ items,
    ...(proposals.length > query.limit ? { nextAfterId: selected.at(-1)!.id } : {}) });
}
