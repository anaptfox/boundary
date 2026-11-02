#![allow(clippy::missing_errors_doc)]
// Every validated constructor returns ControlError::InvalidValue; repeating the
// same Errors section for generated identifier newtypes obscures that invariant.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_TOKEN_BYTES: usize = 256;
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// An error raised while validating or coordinating controlled execution.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ControlError {
    /// A value failed its local shape invariant.
    #[error("invalid control value: {0}")]
    InvalidValue(&'static str),
    /// A referenced durable record does not exist.
    #[error("control record not found: {0}")]
    NotFound(&'static str),
    /// Durable records disagree about the authority they represent.
    #[error("control authority mismatch: {0}")]
    AuthorityMismatch(&'static str),
    /// The relevant authority has expired.
    #[error("control authority expired at {expires_at:?}; current time is {now:?}")]
    AuthorityExpired {
        /// Exclusive expiration instant.
        expires_at: Timestamp,
        /// Clock instant observed by the handler.
        now: Timestamp,
    },
    /// An approval explicitly denied the proposal.
    #[error("proposal was denied")]
    Denied,
    /// A compare-and-swap interaction found conflicting durable state.
    #[error("control journal conflict: {0}")]
    Conflict(&'static str),
    /// The durable store failed.
    #[error("control store failed: {0}")]
    Store(String),
    /// The clock failed.
    #[error("control clock failed: {0}")]
    Clock(String),
    /// Identifier generation failed.
    #[error("control id source failed: {0}")]
    IdSource(String),
    /// A staged policy rejected or failed a transition.
    #[error("control policy failed: {0}")]
    Policy(String),
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && !value.chars().any(char::is_control)
        && value.trim() == value
}

macro_rules! string_newtype {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Validates and constructs the value.
            pub fn new(value: impl Into<String>) -> Result<Self, ControlError> {
                let value = value.into();
                if !valid_token(&value) {
                    return Err(ControlError::InvalidValue($description));
                }
                Ok(Self(value))
            }

            /// Returns the validated text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

string_newtype!(Actor, "actor");
string_newtype!(ProposalId, "proposal id");
string_newtype!(ApprovalId, "approval id");
string_newtype!(GrantId, "grant id");
string_newtype!(AttemptId, "attempt id");
string_newtype!(ClaimId, "claim id");
string_newtype!(LeaseId, "lease id");
string_newtype!(ReceiptId, "receipt id");
string_newtype!(InteractionIdempotencyKey, "interaction idempotency key");

/// An exact changing-interaction identity used by the control subsystem.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlInteractionRef {
    interaction_id: String,
    contract_digest: String,
}

impl ControlInteractionRef {
    /// Constructs an exact reference from validated, bounded tokens.
    pub fn new(
        interaction_id: impl Into<String>,
        contract_digest: impl Into<String>,
    ) -> Result<Self, ControlError> {
        let interaction_id = interaction_id.into();
        let contract_digest = contract_digest.into();
        if !valid_token(&interaction_id) {
            return Err(ControlError::InvalidValue("interaction id"));
        }
        if !valid_token(&contract_digest) {
            return Err(ControlError::InvalidValue("contract digest"));
        }
        Ok(Self {
            interaction_id,
            contract_digest,
        })
    }

    /// Returns the interaction id.
    #[must_use]
    pub fn interaction_id(&self) -> &str {
        &self.interaction_id
    }

    /// Returns the exact contract digest.
    #[must_use]
    pub fn contract_digest(&self) -> &str {
        &self.contract_digest
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        Self::new(&self.interaction_id, &self.contract_digest).map(|_| ())
    }
}

/// Milliseconds since a host-defined epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(u64);

impl Timestamp {
    /// Constructs a timestamp.
    #[must_use]
    pub const fn from_millis(millis: u64) -> Self {
        Self(millis)
    }

    /// Returns the raw millisecond count.
    #[must_use]
    pub const fn as_millis(self) -> u64 {
        self.0
    }

    pub(crate) fn checked_add(self, duration: DurationMillis) -> Result<Self, ControlError> {
        self.0
            .checked_add(duration.0)
            .map(Self)
            .ok_or(ControlError::InvalidValue("timestamp overflow"))
    }
}

/// A non-zero duration in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct DurationMillis(u64);

impl DurationMillis {
    /// Constructs a non-zero duration.
    pub const fn new(millis: u64) -> Result<Self, ControlError> {
        if millis == 0 {
            return Err(ControlError::InvalidValue("duration must be non-zero"));
        }
        Ok(Self(millis))
    }

    /// Returns the raw millisecond count.
    #[must_use]
    pub const fn as_millis(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for DurationMillis {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A content fingerprint pinning approval to one normalized input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InputFingerprint([u8; 32]);

impl InputFingerprint {
    fn for_bytes(bytes: &[u8]) -> Self {
        let mut hash = Sha256::new();
        hash.update(b"boundary-core.control.input/v1\0");
        hash.update(bytes);
        Self(hash.finalize().into())
    }

    /// Returns the digest bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Immutable encoded input normalized once before policy and execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedInput {
    encoding: String,
    bytes: Vec<u8>,
    fingerprint: InputFingerprint,
}

impl NormalizedInput {
    /// Constructs an input envelope and computes its authority fingerprint.
    pub fn new(encoding: impl Into<String>, bytes: Vec<u8>) -> Result<Self, ControlError> {
        let encoding = encoding.into();
        if !valid_token(&encoding) {
            return Err(ControlError::InvalidValue("input encoding"));
        }
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(ControlError::InvalidValue("input exceeds size limit"));
        }
        let fingerprint = InputFingerprint::for_bytes(&bytes);
        Ok(Self {
            encoding,
            bytes,
            fingerprint,
        })
    }

    /// Returns the encoding label selected by the host codec.
    #[must_use]
    pub fn encoding(&self) -> &str {
        &self.encoding
    }

    /// Returns the exact normalized bytes approved for dispatch.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Returns the authority fingerprint.
    #[must_use]
    pub const fn fingerprint(&self) -> InputFingerprint {
        self.fingerprint
    }
}

impl<'de> Deserialize<'de> for NormalizedInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct RawInput {
            encoding: String,
            bytes: Vec<u8>,
            fingerprint: InputFingerprint,
        }

        let raw = RawInput::deserialize(deserializer)?;
        let input = Self::new(raw.encoding, raw.bytes).map_err(serde::de::Error::custom)?;
        if input.fingerprint != raw.fingerprint {
            return Err(serde::de::Error::custom("input fingerprint mismatch"));
        }
        Ok(input)
    }
}

/// A sanitized, portable fault safe to persist in a receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlFault {
    code: String,
    message: String,
}

impl ControlFault {
    /// Constructs a bounded fault.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Result<Self, ControlError> {
        let code = code.into();
        let message = message.into();
        if !valid_token(&code) || code.len() > 128 {
            return Err(ControlError::InvalidValue("fault code"));
        }
        if message.is_empty() || message.len() > 2_048 || message.chars().any(char::is_control) {
            return Err(ControlError::InvalidValue("fault message"));
        }
        Ok(Self { code, message })
    }

    /// Returns the stable machine code.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Returns the sanitized explanation.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn internal(code: &'static str, message: &'static str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        Self::new(&self.code, &self.message).map(|_| ())
    }
}

/// Monotonic fencing token allocated by the execution journal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct FenceToken(u64);

impl FenceToken {
    /// Constructs a non-zero fence token.
    pub const fn new(value: u64) -> Result<Self, ControlError> {
        if value == 0 {
            return Err(ControlError::InvalidValue("fence token must be non-zero"));
        }
        Ok(Self(value))
    }

    /// Returns the journal sequence value.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for FenceToken {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

include!("authority_records.rs");
include!("execution_records.rs");
