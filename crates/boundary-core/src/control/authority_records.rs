/// A request to authorize one exact interaction input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalRecord {
    id: ProposalId,
    interaction: ControlInteractionRef,
    input: NormalizedInput,
    requested_by: Actor,
    requested_at: Timestamp,
    expires_at: Timestamp,
}

impl ProposalRecord {
    pub(crate) fn new(
        id: ProposalId,
        interaction: ControlInteractionRef,
        input: NormalizedInput,
        requested_by: Actor,
        requested_at: Timestamp,
        expires_at: Timestamp,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            interaction,
            input,
            requested_by,
            requested_at,
            expires_at,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the proposal id.
    #[must_use]
    pub fn id(&self) -> &ProposalId {
        &self.id
    }
    /// Returns the exact controlled interaction.
    #[must_use]
    pub fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }
    /// Returns the sole normalized input used for policy and dispatch.
    #[must_use]
    pub fn input(&self) -> &NormalizedInput {
        &self.input
    }
    /// Returns the requesting actor.
    #[must_use]
    pub fn requested_by(&self) -> &Actor {
        &self.requested_by
    }
    /// Returns the request time.
    #[must_use]
    pub const fn requested_at(&self) -> Timestamp {
        self.requested_at
    }
    /// Returns the exclusive expiration time.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        self.interaction.validate()?;
        if self.requested_at >= self.expires_at {
            return Err(ControlError::InvalidValue("proposal time range"));
        }
        Ok(())
    }
}

/// The durable decision made for a proposal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// The proposal may proceed to a bounded grant.
    Approved,
    /// The proposal is denied and can never produce a grant.
    Denied,
}

/// A durable approval or denial pinned to proposal identity and input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRecord {
    id: ApprovalId,
    proposal_id: ProposalId,
    interaction: ControlInteractionRef,
    input_fingerprint: InputFingerprint,
    decision: ApprovalDecision,
    decided_by: Actor,
    decided_at: Timestamp,
    expires_at: Timestamp,
}

impl ApprovalRecord {
    pub(crate) fn new(
        id: ApprovalId,
        proposal: &ProposalRecord,
        decision: ApprovalDecision,
        decided_by: Actor,
        decided_at: Timestamp,
        expires_at: Timestamp,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            proposal_id: proposal.id.clone(),
            interaction: proposal.interaction.clone(),
            input_fingerprint: proposal.input.fingerprint(),
            decision,
            decided_by,
            decided_at,
            expires_at,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the approval id.
    #[must_use]
    pub fn id(&self) -> &ApprovalId {
        &self.id
    }
    /// Returns the approved proposal id.
    #[must_use]
    pub fn proposal_id(&self) -> &ProposalId {
        &self.proposal_id
    }
    /// Returns the exact interaction reference.
    #[must_use]
    pub fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }
    /// Returns the approved input fingerprint.
    #[must_use]
    pub const fn input_fingerprint(&self) -> InputFingerprint {
        self.input_fingerprint
    }
    /// Returns the decision.
    #[must_use]
    pub const fn decision(&self) -> ApprovalDecision {
        self.decision
    }
    /// Returns the deciding actor.
    #[must_use]
    pub fn decided_by(&self) -> &Actor {
        &self.decided_by
    }
    /// Returns the decision time.
    #[must_use]
    pub const fn decided_at(&self) -> Timestamp {
        self.decided_at
    }
    /// Returns the exclusive expiration time.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        self.interaction.validate()?;
        if self.decided_at >= self.expires_at {
            return Err(ControlError::InvalidValue("approval time range"));
        }
        Ok(())
    }
}

/// Bounded authority to execute an approved proposal once per idempotency key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantRecord {
    id: GrantId,
    approval_id: ApprovalId,
    proposal_id: ProposalId,
    interaction: ControlInteractionRef,
    input_fingerprint: InputFingerprint,
    granted_by: Actor,
    valid_from: Timestamp,
    expires_at: Timestamp,
}

impl GrantRecord {
    pub(crate) fn new(
        id: GrantId,
        approval: &ApprovalRecord,
        granted_by: Actor,
        valid_from: Timestamp,
        expires_at: Timestamp,
    ) -> Result<Self, ControlError> {
        let record = Self {
            id,
            approval_id: approval.id.clone(),
            proposal_id: approval.proposal_id.clone(),
            interaction: approval.interaction.clone(),
            input_fingerprint: approval.input_fingerprint,
            granted_by,
            valid_from,
            expires_at,
        };
        record.validate()?;
        Ok(record)
    }

    /// Returns the grant id.
    #[must_use]
    pub fn id(&self) -> &GrantId {
        &self.id
    }
    /// Returns the source approval id.
    #[must_use]
    pub fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }
    /// Returns the source proposal id.
    #[must_use]
    pub fn proposal_id(&self) -> &ProposalId {
        &self.proposal_id
    }
    /// Returns the exact interaction reference.
    #[must_use]
    pub fn interaction(&self) -> &ControlInteractionRef {
        &self.interaction
    }
    /// Returns the authorized input fingerprint.
    #[must_use]
    pub const fn input_fingerprint(&self) -> InputFingerprint {
        self.input_fingerprint
    }
    /// Returns the granting actor.
    #[must_use]
    pub fn granted_by(&self) -> &Actor {
        &self.granted_by
    }
    /// Returns the first valid instant.
    #[must_use]
    pub const fn valid_from(&self) -> Timestamp {
        self.valid_from
    }
    /// Returns the exclusive expiration instant.
    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        self.interaction.validate()?;
        if self.valid_from >= self.expires_at {
            return Err(ControlError::InvalidValue("grant time range"));
        }
        Ok(())
    }
}
