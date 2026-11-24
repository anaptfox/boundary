use thiserror::Error;

/// Stable category for a Program v1 validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ProgramErrorCode {
    /// A portable JSON value could not be canonicalized.
    InvalidJson,
    /// A dynamic interaction identifier is invalid.
    InvalidInteractionId,
    /// A digest is not `sha256:` followed by 64 lowercase hexadecimal digits.
    InvalidDigest,
    /// A schema node or keyword value is invalid.
    InvalidSchema,
    /// A schema contains a keyword outside Program v1.
    UnsupportedSchema,
    /// A contract footprint is invalid.
    InvalidFootprint,
    /// An algebraic interaction trait is invalid.
    InvalidTrait,
    /// A documentation or annotation value is invalid.
    InvalidMetadata,
    /// An encoded version is not supported.
    UnsupportedVersion,
    /// A supplied digest does not match the normalized value.
    DigestMismatch,
    /// A program contains the same interaction identifier twice.
    DuplicateInteraction,
    /// A catalog references an interaction absent from its program.
    UnknownInteraction,
    /// A Draft's gap explanation was empty.
    EmptyGap,
    /// A Draft's proposer was empty.
    EmptyProposer,
    /// A Draft's `createdAt` was not a valid ISO-8601 timestamp.
    InvalidTimestamp,
}

/// Structured, stable failure from Program construction or validation.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{code:?} at {path}: {message}")]
pub struct ProgramError {
    code: ProgramErrorCode,
    path: String,
    message: String,
}

impl ProgramError {
    pub(crate) fn new(
        code: ProgramErrorCode,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }

    /// Returns the stable failure category.
    #[must_use]
    pub const fn code(&self) -> ProgramErrorCode {
        self.code
    }

    /// Returns the stable structural path to the rejected value.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Returns the human-readable explanation.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}
