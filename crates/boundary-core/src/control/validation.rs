use std::fmt::Display;

use super::handler::Authorized;
use super::{
    ApprovalDecision, ApprovalId, ApprovalRecord, AttemptRecord, AuthorityStore, Clock,
    ControlError, ControlInteractionRef, ControlPolicy, ControlledHandler, ExecutionJournal,
    GrantId, GrantRecord, IdSource, LeaseRecord, LeaseRequest, ProposalId, ProposalRecord,
    ReceiptRecord, Timestamp,
};

impl<S, C, I, P> ControlledHandler<S, C, I, P>
where
    S: AuthorityStore + ExecutionJournal,
    C: Clock,
    I: IdSource,
    P: ControlPolicy,
{
    pub(super) fn validate_proposal(
        &self,
        proposal: &ProposalRecord,
        now: Timestamp,
    ) -> Result<(), ControlError> {
        proposal.validate()?;
        self.validate_interaction(proposal.interaction())?;
        validate_live(now, proposal.requested_at(), proposal.expires_at())
    }

    pub(super) fn validate_approval(
        &self,
        proposal: &ProposalRecord,
        approval: &ApprovalRecord,
        now: Timestamp,
    ) -> Result<(), ControlError> {
        self.validate_proposal(proposal, now)?;
        approval.validate()?;
        if approval.proposal_id() != proposal.id()
            || approval.interaction() != proposal.interaction()
            || approval.input_fingerprint() != proposal.input().fingerprint()
        {
            return Err(ControlError::AuthorityMismatch("approval chain"));
        }
        validate_live(now, approval.decided_at(), approval.expires_at())
    }

    pub(super) fn validate_interaction(
        &self,
        interaction: &ControlInteractionRef,
    ) -> Result<(), ControlError> {
        if interaction != self.interaction() {
            return Err(ControlError::AuthorityMismatch("controlled interaction"));
        }
        Ok(())
    }

    pub(super) fn load_proposal(&self, id: &ProposalId) -> Result<ProposalRecord, ControlError> {
        self.store()
            .proposal(id)
            .map_err(store_error)?
            .ok_or(ControlError::NotFound("proposal"))
    }

    pub(super) fn load_approval(&self, id: &ApprovalId) -> Result<ApprovalRecord, ControlError> {
        self.store()
            .approval(id)
            .map_err(store_error)?
            .ok_or(ControlError::NotFound("approval"))
    }

    pub(super) fn load_grant(&self, id: &GrantId) -> Result<GrantRecord, ControlError> {
        self.store()
            .grant(id)
            .map_err(store_error)?
            .ok_or(ControlError::NotFound("grant"))
    }

    pub(super) fn load_authorized(
        &self,
        grant_id: &GrantId,
        now: Timestamp,
    ) -> Result<Authorized, ControlError> {
        let grant = self.load_grant(grant_id)?;
        let approval = self.load_approval(grant.approval_id())?;
        let proposal = self.load_proposal(grant.proposal_id())?;
        self.validate_approval(&proposal, &approval, now)?;
        if approval.decision() != ApprovalDecision::Approved {
            return Err(ControlError::Denied);
        }
        if grant.approval_id() != approval.id()
            || grant.proposal_id() != proposal.id()
            || grant.interaction() != proposal.interaction()
            || grant.input_fingerprint() != proposal.input().fingerprint()
        {
            return Err(ControlError::AuthorityMismatch("grant chain"));
        }
        grant.validate()?;
        self.validate_interaction(grant.interaction())?;
        validate_live(now, grant.valid_from(), grant.expires_at())?;
        Ok(Authorized { proposal, grant })
    }
}

pub(super) fn validate_attempt(
    actual: &AttemptRecord,
    expected: &AttemptRecord,
) -> Result<(), ControlError> {
    actual.validate()?;
    if actual.idempotency_key() != expected.idempotency_key()
        || actual.grant_id() != expected.grant_id()
        || actual.proposal_id() != expected.proposal_id()
        || actual.interaction() != expected.interaction()
        || actual.input_fingerprint() != expected.input_fingerprint()
    {
        return Err(ControlError::Conflict(
            "idempotency key reused with different authority",
        ));
    }
    Ok(())
}

pub(super) fn validate_receipt(
    receipt: &ReceiptRecord,
    attempt: &AttemptRecord,
) -> Result<(), ControlError> {
    receipt.validate()?;
    if receipt.attempt_id() != attempt.id()
        || receipt.interaction() != attempt.interaction()
        || receipt.input_fingerprint() != attempt.input_fingerprint()
    {
        return Err(ControlError::Conflict("receipt authority mismatch"));
    }
    Ok(())
}

pub(super) fn validate_live(
    now: Timestamp,
    valid_from: Timestamp,
    expires_at: Timestamp,
) -> Result<(), ControlError> {
    if now < valid_from {
        return Err(ControlError::AuthorityMismatch(
            "authority is not active yet",
        ));
    }
    if now >= expires_at {
        return Err(ControlError::AuthorityExpired { expires_at, now });
    }
    Ok(())
}

pub(super) fn validate_acquired_lease(
    lease: &LeaseRecord,
    request: &LeaseRequest,
) -> Result<(), ControlError> {
    lease.validate()?;
    if lease.attempt_id() != request.attempt_id()
        || lease.id() != request.lease_id()
        || lease.claim_id() != request.claim_id()
        || lease.owner() != request.owner()
        || lease.acquired_at() != request.now()
        || lease.expires_at() != request.expires_at()
    {
        return Err(ControlError::Conflict("journal returned mismatched lease"));
    }
    Ok(())
}

fn store_error(error: impl Display) -> ControlError {
    ControlError::Store(error.to_string())
}
