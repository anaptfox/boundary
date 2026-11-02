use super::outcome::{journal_uncertain, live_uncertain, policy_error, store_error};
use super::validation::{validate_acquired_lease, validate_attempt, validate_receipt};
use super::{
    Actor, ApplyFailure, ApplyPermit, ApplyResult, ApprovalDecision, ApprovalId, ApprovalRecord,
    AttemptId, AttemptRecord, AuthorityStore, BeginAttempt, ClaimId, Clock, CommitReceipt,
    ControlError, ControlInteractionRef, ControlOutcome, ControlPolicy, ControlledEffect,
    DurationMillis, ExecutionJournal, GrantId, GrantRecord, IdKind, IdSource,
    InteractionIdempotencyKey, LeaseClaim, LeaseId, LeaseRecord, LeaseRequest, NormalizedInput,
    ProposalId, ProposalRecord, ReceiptId, ReceiptOutcome, ReceiptRecord, ReconcileContext,
    Reconciliation, StoreInsert, Timestamp, Verification,
};

pub(super) struct Authorized {
    pub(super) proposal: ProposalRecord,
    pub(super) grant: GrantRecord,
}
struct Claimed {
    attempt: AttemptRecord,
    input: NormalizedInput,
    lease: LeaseRecord,
}

/// Coordinates durable authority, fenced application, verification, and recovery.
///
/// The handler does not implement an interaction and does not modify a program.
/// Hosts explicitly wrap a changing interaction and provide persistence, time,
/// identity, policy, and effect adapters.
pub struct ControlledHandler<S, C, I, P> {
    interaction: ControlInteractionRef,
    store: S,
    clock: C,
    ids: I,
    policy: P,
}

impl<S, C, I, P> ControlledHandler<S, C, I, P>
where
    S: AuthorityStore + ExecutionJournal,
    C: Clock,
    I: IdSource,
    P: ControlPolicy,
{
    /// Installs control around one exact changing-interaction contract.
    #[must_use]
    pub fn new(interaction: ControlInteractionRef, store: S, clock: C, ids: I, policy: P) -> Self {
        Self {
            interaction,
            store,
            clock,
            ids,
            policy,
        }
    }

    /// Returns the controlled interaction reference.
    #[must_use]
    pub const fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }

    /// Returns a shared view of durable storage.
    #[must_use]
    pub const fn store(&self) -> &S {
        &self.store
    }

    /// Returns a mutable view of durable storage for host maintenance.
    pub const fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    /// Decomposes the handler into its host-provided parts.
    #[must_use]
    pub fn into_parts(self) -> (ControlInteractionRef, S, C, I, P) {
        (
            self.interaction,
            self.store,
            self.clock,
            self.ids,
            self.policy,
        )
    }

    /// Creates and durably records an authorization proposal.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when time, identity, policy, validation, or
    /// durable insertion fails.
    pub fn request(
        &mut self,
        input: NormalizedInput,
        requested_by: Actor,
        lifetime: DurationMillis,
    ) -> Result<ProposalRecord, ControlError> {
        let now = self.now()?;
        let proposal = ProposalRecord::new(
            ProposalId::new(self.next_id(IdKind::Proposal)?)?,
            self.interaction.clone(),
            input,
            requested_by,
            now,
            now.checked_add(lifetime)?,
        )?;
        self.policy.request(&proposal).map_err(policy_error)?;
        match self
            .store
            .insert_proposal(proposal.clone())
            .map_err(store_error)?
        {
            StoreInsert::Inserted => Ok(proposal),
            StoreInsert::Existing(_) => Err(ControlError::Conflict("proposal id collision")),
        }
    }

    /// Records an explicit approval or denial for a live proposal.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when the proposal is absent, mismatched, or
    /// expired, or when a host stage fails.
    pub fn approve(
        &mut self,
        proposal_id: &ProposalId,
        decision: ApprovalDecision,
        decided_by: Actor,
        lifetime: DurationMillis,
    ) -> Result<ApprovalRecord, ControlError> {
        let now = self.now()?;
        let proposal = self.load_proposal(proposal_id)?;
        self.validate_proposal(&proposal, now)?;
        let expires_at = now.checked_add(lifetime)?.min(proposal.expires_at());
        let approval = ApprovalRecord::new(
            ApprovalId::new(self.next_id(IdKind::Approval)?)?,
            &proposal,
            decision,
            decided_by,
            now,
            expires_at,
        )?;
        self.policy
            .approve(&proposal, &approval)
            .map_err(policy_error)?;
        match self
            .store
            .insert_approval(approval.clone())
            .map_err(store_error)?
        {
            StoreInsert::Inserted => Ok(approval),
            StoreInsert::Existing(_) => Err(ControlError::Conflict("approval id collision")),
        }
    }

    /// Produces bounded execution authority from a live approval.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when the approval chain is invalid, denied, or
    /// expired, or when a host stage fails.
    pub fn grant(
        &mut self,
        approval_id: &ApprovalId,
        granted_by: Actor,
        lifetime: DurationMillis,
    ) -> Result<GrantRecord, ControlError> {
        let now = self.now()?;
        let approval = self.load_approval(approval_id)?;
        let proposal = self.load_proposal(approval.proposal_id())?;
        self.validate_approval(&proposal, &approval, now)?;
        if approval.decision() != ApprovalDecision::Approved {
            return Err(ControlError::Denied);
        }
        let expires_at = now
            .checked_add(lifetime)?
            .min(approval.expires_at())
            .min(proposal.expires_at());
        let grant = GrantRecord::new(
            GrantId::new(self.next_id(IdKind::Grant)?)?,
            &approval,
            granted_by,
            now,
            expires_at,
        )?;
        self.policy
            .grant(&proposal, &approval, &grant)
            .map_err(policy_error)?;
        match self
            .store
            .insert_grant(grant.clone())
            .map_err(store_error)?
        {
            StoreInsert::Inserted => Ok(grant),
            StoreInsert::Existing(_) => Err(ControlError::Conflict("grant id collision")),
        }
    }

    /// Starts or resumes one idempotent execution.
    ///
    /// A newly created attempt may call `apply` once. An existing attempt is
    /// routed to reconciliation and can never receive an [`ApplyPermit`].
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] before apply for invalid authority or host
    /// failures. Post-apply uncertainty is returned as [`ControlOutcome`].
    pub fn execute<E>(
        &mut self,
        grant_id: &GrantId,
        idempotency_key: InteractionIdempotencyKey,
        owner: Actor,
        lease_lifetime: DurationMillis,
        effect: &mut E,
    ) -> Result<ControlOutcome, ControlError>
    where
        E: ControlledEffect,
    {
        let now = self.now()?;
        let authorized = self.load_authorized(grant_id, now)?;
        self.policy
            .execute(
                &authorized.proposal,
                &authorized.grant,
                &owner,
                &idempotency_key,
            )
            .map_err(policy_error)?;
        let candidate = AttemptRecord::new(
            AttemptId::new(self.next_id(IdKind::Attempt)?)?,
            idempotency_key,
            &authorized.grant,
            now,
        )?;
        match self
            .store
            .begin_attempt(candidate.clone())
            .map_err(store_error)?
        {
            BeginAttempt::Started(attempt) => {
                validate_attempt(&attempt, &candidate)?;
                let receipt_id = ReceiptId::new(self.next_id(IdKind::Receipt)?)?;
                let attempt_id = attempt.id().clone();
                let claimed = match self.claim(
                    attempt,
                    authorized.proposal.input().clone(),
                    owner,
                    now,
                    lease_lifetime,
                ) {
                    Ok(claimed) => claimed,
                    Err(ControlError::Conflict("live executor")) => {
                        return Ok(live_uncertain(attempt_id, None));
                    }
                    Err(error) => return Err(error),
                };
                self.apply_new(&claimed, receipt_id, now, effect)
            }
            BeginAttempt::Existing(attempt) => {
                validate_attempt(&attempt, &candidate)?;
                self.recover(
                    attempt,
                    authorized.proposal.input().clone(),
                    owner,
                    now,
                    lease_lifetime,
                    effect,
                )
            }
        }
    }

    /// Explicitly recovers an attempt, including after its grant has expired.
    ///
    /// Recovery can classify and verify prior work but has no path to `apply`.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when the attempt or its pinned input is absent
    /// or mismatched, or when a pre-recovery host stage fails.
    pub fn reconcile<E>(
        &mut self,
        attempt_id: &AttemptId,
        owner: Actor,
        lease_lifetime: DurationMillis,
        effect: &mut E,
    ) -> Result<ControlOutcome, ControlError>
    where
        E: ControlledEffect,
    {
        let now = self.now()?;
        let attempt = self
            .store
            .attempt(attempt_id)
            .map_err(store_error)?
            .ok_or(ControlError::NotFound("attempt"))?;
        attempt.validate()?;
        self.validate_interaction(attempt.interaction())?;
        let proposal = self.load_proposal(attempt.proposal_id())?;
        if proposal.input().fingerprint() != attempt.input_fingerprint()
            || proposal.interaction() != attempt.interaction()
        {
            return Err(ControlError::AuthorityMismatch("attempt proposal"));
        }
        self.recover(
            attempt,
            proposal.input().clone(),
            owner,
            now,
            lease_lifetime,
            effect,
        )
    }

    fn apply_new<E>(
        &mut self,
        claimed: &Claimed,
        receipt_id: ReceiptId,
        now: Timestamp,
        effect: &mut E,
    ) -> Result<ControlOutcome, ControlError>
    where
        E: ControlledEffect,
    {
        let outcome = match effect.apply(&claimed.input, ApplyPermit::from_lease(&claimed.lease)) {
            Ok(applied) => Self::verify(effect, &claimed.input, &applied),
            Err(ApplyFailure::NotApplied(error)) => ReceiptOutcome::NotApplied {
                fault: error.into(),
            },
            Err(ApplyFailure::Uncertain(error)) => ReceiptOutcome::Uncertain {
                fault: error.into(),
            },
        };
        self.commit(claimed, receipt_id, outcome, now, false, None)
    }

    fn recover<E>(
        &mut self,
        attempt: AttemptRecord,
        input: NormalizedInput,
        owner: Actor,
        now: Timestamp,
        lease_lifetime: DurationMillis,
        effect: &mut E,
    ) -> Result<ControlOutcome, ControlError>
    where
        E: ControlledEffect,
    {
        let previous = self.store.receipt(attempt.id()).map_err(store_error)?;
        if let Some(receipt) = &previous {
            validate_receipt(receipt, &attempt)?;
            if !matches!(receipt.outcome(), ReceiptOutcome::Uncertain { .. }) {
                return ControlOutcome::from_receipt(receipt.clone());
            }
        }
        self.policy
            .reconcile(&attempt, previous.as_ref(), &owner)
            .map_err(policy_error)?;
        let receipt_id = ReceiptId::new(self.next_id(IdKind::Receipt)?)?;
        let attempt_id = attempt.id().clone();
        let claimed = match self.claim(attempt, input, owner, now, lease_lifetime) {
            Ok(claimed) => claimed,
            Err(ControlError::Conflict("live executor")) => {
                return Ok(live_uncertain(attempt_id, previous));
            }
            Err(error) => return Err(error),
        };
        let result = effect.reconcile(
            &claimed.input,
            ReconcileContext::new(&claimed.attempt, previous.as_ref(), now),
        );
        let outcome = match result {
            Ok(Reconciliation::Applied(applied)) => Self::verify(effect, &claimed.input, &applied),
            Ok(Reconciliation::NotApplied(fault)) => ReceiptOutcome::NotApplied { fault },
            Ok(Reconciliation::Uncertain(fault)) => ReceiptOutcome::Uncertain { fault },
            Err(error) => ReceiptOutcome::Uncertain {
                fault: error.into(),
            },
        };
        let expected = previous.as_ref().map(ReceiptRecord::id);
        self.commit(&claimed, receipt_id, outcome, now, true, expected)
    }

    fn verify<E>(effect: &mut E, input: &NormalizedInput, applied: &ApplyResult) -> ReceiptOutcome
    where
        E: ControlledEffect,
    {
        match effect.verify(input, applied) {
            Ok(Verification::Completed) => ReceiptOutcome::Completed {
                output: applied.output().to_vec(),
            },
            Ok(Verification::NotApplied(fault)) => ReceiptOutcome::NotApplied { fault },
            Ok(Verification::Uncertain(fault)) => ReceiptOutcome::Uncertain { fault },
            Err(error) => ReceiptOutcome::Uncertain {
                fault: error.into(),
            },
        }
    }

    fn commit(
        &mut self,
        claimed: &Claimed,
        receipt_id: ReceiptId,
        outcome: ReceiptOutcome,
        now: Timestamp,
        reconciled: bool,
        expected: Option<&ReceiptId>,
    ) -> Result<ControlOutcome, ControlError> {
        let receipt = ReceiptRecord::new(
            receipt_id,
            &claimed.attempt,
            outcome,
            &claimed.lease,
            now,
            reconciled,
        )?;
        match self.store.commit_receipt(expected, &claimed.lease, receipt) {
            Ok(CommitReceipt::Committed(record) | CommitReceipt::Existing(record)) => {
                validate_receipt(&record, &claimed.attempt)?;
                ControlOutcome::from_receipt(record)
            }
            Ok(CommitReceipt::LeaseLost) | Err(_) => {
                Ok(journal_uncertain(claimed.attempt.id().clone()))
            }
        }
    }

    fn claim(
        &mut self,
        attempt: AttemptRecord,
        input: NormalizedInput,
        owner: Actor,
        now: Timestamp,
        lifetime: DurationMillis,
    ) -> Result<Claimed, ControlError> {
        let request = LeaseRequest::new(
            attempt.id().clone(),
            LeaseId::new(self.next_id(IdKind::Lease)?)?,
            ClaimId::new(self.next_id(IdKind::Claim)?)?,
            owner,
            now,
            now.checked_add(lifetime)?,
        );
        match self
            .store
            .claim_lease(request.clone())
            .map_err(store_error)?
        {
            LeaseClaim::Acquired(lease) => {
                validate_acquired_lease(&lease, &request)?;
                Ok(Claimed {
                    attempt,
                    input,
                    lease,
                })
            }
            LeaseClaim::Live(lease) => {
                lease.validate()?;
                if lease.attempt_id() != attempt.id() || lease.expires_at() <= now {
                    return Err(ControlError::Conflict("invalid live lease"));
                }
                Err(ControlError::Conflict("live executor"))
            }
        }
    }

    fn now(&self) -> Result<Timestamp, ControlError> {
        self.clock
            .now()
            .map_err(|error| ControlError::Clock(error.to_string()))
    }
    fn next_id(&mut self, kind: IdKind) -> Result<String, ControlError> {
        self.ids
            .next_id(kind)
            .map_err(|error| ControlError::IdSource(error.to_string()))
    }
}
