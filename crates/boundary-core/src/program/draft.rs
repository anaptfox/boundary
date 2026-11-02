//! The interaction Draft: a bot proposes a contract that does not exist yet.
//!
//! "Proposal" already names Control's pending effect, so a contract that does
//! not yet exist gets its own word. A Draft wraps a *full* interaction
//! contract — the entire declared identity in [`super::contract`], never a
//! fragment — because anything less would fork contract identity, which is
//! the whole thing to avoid. It adds only what a proposal needs on top: the
//! gap the contract would fill, who proposed it, and when.
//!
//! A Draft is not a Program entry. [`super::descriptor::Program`] never
//! contains one, and nothing here is callable. It is an inert artifact: a
//! person still reviews and, if accepted, a host still declares the contract
//! through the ordinary [`InteractionContract`] path. Declaration remains
//! distinct from realization, and interfaces still narrow authority rather
//! than invent it.
//!
//! `createdAt` is a host-supplied ISO-8601 timestamp. Boundary never reads a clock
//! internally; ambient time would be unreviewable, silently varying input.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    DraftDigest, InteractionContract, ProgramError, ProgramErrorCode, canonical::hash_json,
    timestamp::is_valid_timestamp,
};

const DRAFT_DOMAIN: &str = "boundary.interaction-draft/v1";

/// An inert artifact proposing a full interaction contract that does not exist
/// yet.
///
/// A Draft is never a Program entry and is never callable. The v1 draft
/// digest hashes `version`, the contract's own identity value, `gap`,
/// `proposer`, and `createdAt`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    version: u8,
    contract: InteractionContract,
    gap: String,
    proposer: String,
    created_at: String,
    #[serde(rename = "draftDigest")]
    digest: DraftDigest,
}

impl Draft {
    /// Builds and validates a Draft, computing its digest.
    ///
    /// `contract` is validated the same way any [`InteractionContract`] is:
    /// only a value that already passed [`InteractionContract::builder`] (or
    /// round-tripped through its own validating deserializer) can be named
    /// here.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when `gap` or `proposer` is empty, or
    /// `created_at` is not a valid ISO-8601 timestamp.
    pub fn new(
        contract: InteractionContract,
        gap: impl Into<String>,
        proposer: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Result<Self, ProgramError> {
        let gap = gap.into();
        if gap.trim().is_empty() {
            return Err(ProgramError::new(
                ProgramErrorCode::EmptyGap,
                "draft.gap",
                "a draft's gap explanation must not be empty",
            ));
        }
        let proposer = proposer.into();
        if proposer.trim().is_empty() {
            return Err(ProgramError::new(
                ProgramErrorCode::EmptyProposer,
                "draft.proposer",
                "a draft's proposer must not be empty",
            ));
        }
        let created_at = created_at.into();
        if !is_valid_timestamp(&created_at) {
            return Err(ProgramError::new(
                ProgramErrorCode::InvalidTimestamp,
                "draft.createdAt",
                "a draft's createdAt must be a valid ISO-8601 timestamp",
            ));
        }

        let digest = DraftDigest::from_hash(hash_json(
            DRAFT_DOMAIN,
            &identity_value(&contract, &gap, &proposer, &created_at),
        )?);

        Ok(Self {
            version: 1,
            contract,
            gap,
            proposer,
            created_at,
            digest,
        })
    }

    /// Returns the drafted interaction contract.
    #[must_use]
    pub const fn contract(&self) -> &InteractionContract {
        &self.contract
    }

    /// Returns free text explaining what is missing.
    #[must_use]
    pub fn gap(&self) -> &str {
        &self.gap
    }

    /// Returns the opaque host-supplied proposer identity.
    #[must_use]
    pub fn proposer(&self) -> &str {
        &self.proposer
    }

    /// Returns the host-supplied ISO-8601 creation timestamp.
    #[must_use]
    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    /// Returns this draft's own digest.
    #[must_use]
    pub const fn draft_digest(&self) -> &DraftDigest {
        &self.digest
    }

    /// Recomputes and checks the digest of a draft that crossed a boundary.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when the draft does not canonicalize or its
    /// recorded digest does not match its content.
    pub fn verify(&self) -> Result<(), ProgramError> {
        let recomputed = DraftDigest::from_hash(hash_json(
            DRAFT_DOMAIN,
            &identity_value(&self.contract, &self.gap, &self.proposer, &self.created_at),
        )?);
        if recomputed == self.digest {
            Ok(())
        } else {
            Err(ProgramError::new(
                ProgramErrorCode::DigestMismatch,
                "draft.draftDigest",
                format!(
                    "draft digest mismatch: recorded {}, recomputed {recomputed}",
                    self.digest
                ),
            ))
        }
    }
}

fn identity_value(
    contract: &InteractionContract,
    gap: &str,
    proposer: &str,
    created_at: &str,
) -> Value {
    json!({
        "version": 1,
        "contract": contract.identity_value(),
        "gap": gap,
        "proposer": proposer,
        "createdAt": created_at,
    })
}
