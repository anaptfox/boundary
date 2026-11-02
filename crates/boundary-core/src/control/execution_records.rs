/// Durable intent to execute a grant under one idempotency key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptRecord {
    id: AttemptId,
    idempotency_key: InteractionIdempotencyKey,
    grant_id: GrantId,
    proposal_id: ProposalId,
    interaction: ControlInteractionRef,
    input_fingerprint: InputFingerprint,
    started_at: Timestamp,
}

impl AttemptRecord {
    pub(crate) fn new(
        id: AttemptId,
        idempotency_key: InteractionIdempotencyKey,
        grant: &GrantRecord,
        started_at: Timestamp,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            idempotency_key,
            grant_id: grant.id.clone(),
            proposal_id: grant.proposal_id.clone(),
            interaction: grant.interaction.clone(),
            input_fingerprint: grant.input_fingerprint,
            started_at,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the attempt id.
    #[must_use]
    pub fn id(&self) -> &AttemptId {
        &self.id
    }
    /// Returns the interaction-scoped idempotency key.
    #[must_use]
    pub fn idempotency_key(&self) -> &InteractionIdempotencyKey {
        &self.idempotency_key
    }
    /// Returns the authorizing grant id.
    #[must_use]
    pub fn grant_id(&self) -> &GrantId {
        &self.grant_id
    }
    /// Returns the proposal id.
    #[must_use]
    pub fn proposal_id(&self) -> &ProposalId {
        &self.proposal_id
    }
    /// Returns the exact interaction reference.
    #[must_use]
    pub fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }
    /// Returns the input fingerprint.
    #[must_use]
    pub const fn input_fingerprint(&self) -> InputFingerprint {
        self.input_fingerprint
    }
    /// Returns the attempt creation time.
    #[must_use]
    pub const fn started_at(&self) -> Timestamp {
        self.started_at
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        self.interaction.validate()
    }
}

/// Durable exclusive execution claim for an attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseRecord {
    id: LeaseId,
    attempt_id: AttemptId,
    claim_id: ClaimId,
    owner: Actor,
    acquired_at: Timestamp,
    expires_at: Timestamp,
    fence: FenceToken,
}

impl LeaseRecord {
    /// Constructs a lease returned by an execution journal.
    ///
    /// The journal must allocate `fence` monotonically for the attempt.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError`] when the lease time range is empty or invalid.
    pub fn new(
        id: LeaseId,
        attempt_id: AttemptId,
        claim_id: ClaimId,
        owner: Actor,
        acquired_at: Timestamp,
        expires_at: Timestamp,
        fence: FenceToken,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            attempt_id,
            claim_id,
            owner,
            acquired_at,
            expires_at,
            fence,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the lease id.
    #[must_use]
    pub fn id(&self) -> &LeaseId {
        &self.id
    }
    /// Returns the claimed attempt id.
    #[must_use]
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }
    /// Returns the unique claim id.
    #[must_use]
    pub fn claim_id(&self) -> &ClaimId {
        &self.claim_id
    }
    /// Returns the executor identity.
    #[must_use]
    pub fn owner(&self) -> &Actor {
        &self.owner
    }
    /// Returns the acquisition time.
    #[must_use]
    pub const fn acquired_at(&self) -> Timestamp {
        self.acquired_at
    }
    /// Returns the exclusive lease expiration time.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }
    /// Returns the journal-allocated fencing token.
    #[must_use]
    pub const fn fence(&self) -> FenceToken {
        self.fence
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        if self.acquired_at >= self.expires_at {
            return Err(ControlError::InvalidValue("lease time range"));
        }
        Ok(())
    }
}

/// Durable result classification for an attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReceiptOutcome {
    /// Apply and verification established completion.
    Completed {
        /// Encoded output returned by the controlled interaction.
        output: Vec<u8>,
    },
    /// The effect is known not to have happened.
    NotApplied {
        /// Sanitized reason the effect did not happen.
        fault: ControlFault,
    },
    /// Whether the effect happened cannot yet be established.
    Uncertain {
        /// Sanitized reason completion could not be established.
        fault: ControlFault,
    },
}

/// Durable receipt committed under the lease fence that observed the outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptRecord {
    id: ReceiptId,
    attempt_id: AttemptId,
    interaction: ControlInteractionRef,
    input_fingerprint: InputFingerprint,
    outcome: ReceiptOutcome,
    fence: FenceToken,
    recorded_at: Timestamp,
    reconciled: bool,
}

impl ReceiptRecord {
    pub(crate) fn new(
        id: ReceiptId,
        attempt: &AttemptRecord,
        outcome: ReceiptOutcome,
        lease: &LeaseRecord,
        recorded_at: Timestamp,
        reconciled: bool,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            attempt_id: attempt.id.clone(),
            interaction: attempt.interaction.clone(),
            input_fingerprint: attempt.input_fingerprint,
            outcome,
            fence: lease.fence,
            recorded_at,
            reconciled,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the receipt id.
    #[must_use]
    pub fn id(&self) -> &ReceiptId {
        &self.id
    }
    /// Returns the attempt id.
    #[must_use]
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }
    /// Returns the exact interaction reference.
    #[must_use]
    pub fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }
    /// Returns the input fingerprint.
    #[must_use]
    pub const fn input_fingerprint(&self) -> InputFingerprint {
        self.input_fingerprint
    }
    /// Returns the classified outcome.
    #[must_use]
    pub const fn outcome(&self) -> &ReceiptOutcome {
        &self.outcome
    }
    /// Returns the committing fence.
    #[must_use]
    pub const fn fence(&self) -> FenceToken {
        self.fence
    }
    /// Returns the receipt time.
    #[must_use]
    pub const fn recorded_at(&self) -> Timestamp {
        self.recorded_at
    }
    /// Reports whether this receipt was produced by reconciliation.
    #[must_use]
    pub const fn reconciled(&self) -> bool {
        self.reconciled
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        self.interaction.validate()?;
        match &self.outcome {
            ReceiptOutcome::Completed { output } if output.len() > MAX_OUTPUT_BYTES => {
                return Err(ControlError::InvalidValue("output exceeds size limit"));
            }
            ReceiptOutcome::NotApplied { fault } | ReceiptOutcome::Uncertain { fault } => {
                fault.validate()?;
            }
            ReceiptOutcome::Completed { .. } => {}
        }
        Ok(())
    }
}

/// A single-use capability required at the mutation boundary.
///
/// It intentionally has no `Clone` implementation:
///
/// ```compile_fail
/// use boundary_core::control::ApplyPermit;
/// fn duplicate(permit: ApplyPermit) {
///     let _copy = permit.clone();
/// }
/// ```
#[derive(Debug)]
pub struct ApplyPermit {
    attempt_id: AttemptId,
    claim_id: ClaimId,
    lease_id: LeaseId,
    fence: FenceToken,
    expires_at: Timestamp,
}

impl ApplyPermit {
    pub(crate) fn from_lease(lease: &LeaseRecord) -> Self {
        Self {
            attempt_id: lease.attempt_id.clone(),
            claim_id: lease.claim_id.clone(),
            lease_id: lease.id.clone(),
            fence: lease.fence,
            expires_at: lease.expires_at,
        }
    }

    /// Returns the authorized attempt.
    #[must_use]
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }
    /// Returns the unique execution claim.
    #[must_use]
    pub fn claim_id(&self) -> &ClaimId {
        &self.claim_id
    }
    /// Returns the backing lease.
    #[must_use]
    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }
    /// Returns the fence that the state mutation must compare atomically.
    #[must_use]
    pub const fn fence(&self) -> FenceToken {
        self.fence
    }
    /// Returns the exclusive permit expiration time.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }
}

/// Result returned to a caller after controlled execution or recovery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlOutcome {
    /// A durable completed receipt.
    Completed(ReceiptRecord),
    /// A durable not-applied receipt.
    NotApplied(ReceiptRecord),
    /// Completion is unknown; a receipt exists when this executor observed it.
    Uncertain {
        /// Attempt whose result is unknown.
        attempt_id: AttemptId,
        /// Durable uncertain receipt, absent while another executor owns a live lease.
        receipt: Option<ReceiptRecord>,
        /// Sanitized reason for uncertainty.
        fault: ControlFault,
    },
}

impl ControlOutcome {
    pub(crate) fn from_receipt(receipt: ReceiptRecord) -> Result<Self, ControlError> {
        receipt.validate()?;
        match &receipt.outcome {
            ReceiptOutcome::Completed { .. } => Ok(Self::Completed(receipt)),
            ReceiptOutcome::NotApplied { .. } => Ok(Self::NotApplied(receipt)),
            ReceiptOutcome::Uncertain { fault } => {
                let attempt_id = receipt.attempt_id.clone();
                let fault = fault.clone();
                Ok(Self::Uncertain {
                    attempt_id,
                    receipt: Some(receipt),
                    fault,
                })
            }
        }
    }
}
