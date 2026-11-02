use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};

use super::{ProgramError, ProgramErrorCode};

/// Stable identity of an interaction, such as `todos.create`.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct InteractionId(String);

impl InteractionId {
    /// Parses and validates a dynamic interaction identifier.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] if the value is empty, non-ASCII, too long, or
    /// contains characters outside the Program v1 token grammar.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ProgramError> {
        let value = value.as_ref();
        if !valid_interaction_id(value) {
            return Err(ProgramError::new(
                ProgramErrorCode::InvalidInteractionId,
                "interaction.id",
                "interaction id must match [A-Za-z0-9][A-Za-z0-9._~-]{0,127}",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the identifier text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for InteractionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for InteractionId {
    type Err = ProgramError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl<'de> Deserialize<'de> for InteractionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// An interaction identifier stored in static program metadata.
///
/// Construct this with [`crate::interaction_id!`]. Dynamic program construction
/// validates it again before it becomes an [`InteractionId`].
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StaticInteractionId(&'static str);

impl StaticInteractionId {
    /// Creates a value already checked by [`crate::interaction_id!`].
    #[doc(hidden)]
    #[must_use]
    pub const fn __new_validated(value: &'static str) -> Self {
        Self(value)
    }

    /// Returns the identifier text.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }

    /// Converts to the owned, validated boundary type.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] if a manually constructed static value does not
    /// satisfy the v1 grammar. [`crate::interaction_id!`] prevents this case.
    pub fn to_owned(self) -> Result<InteractionId, ProgramError> {
        InteractionId::parse(self.0)
    }
}

impl fmt::Display for StaticInteractionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

macro_rules! digest_type {
    ($name:ident, $label:literal) => {
        #[doc = concat!("A validated SHA-256 digest for ", $label, ".")]
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            #[doc = "Parses a lowercase `sha256:<hex>` digest."]
            #[doc = ""]
            #[doc = "# Errors"]
            #[doc = ""]
            #[doc = "Returns `ProgramError` unless the value is exactly `sha256:` plus 64 lowercase hexadecimal digits."]
            pub fn parse(value: impl AsRef<str>) -> Result<Self, ProgramError> {
                let value = value.as_ref();
                if !valid_digest(value) {
                    return Err(ProgramError::new(
                        ProgramErrorCode::InvalidDigest,
                        $label,
                        "digest must be sha256: followed by 64 lowercase hexadecimal digits",
                    ));
                }
                Ok(Self(value.to_owned()))
            }

            pub(crate) fn from_hash(bytes: [u8; 32]) -> Self {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let mut value = String::with_capacity(71);
                value.push_str("sha256:");
                for byte in bytes {
                    value.push(char::from(HEX[usize::from(byte >> 4)]));
                    value.push(char::from(HEX[usize::from(byte & 0x0f)]));
                }
                Self(value)
            }

            #[doc = "Returns the encoded digest."]
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::parse(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

digest_type!(ContractDigest, "interaction contract");
digest_type!(ProgramDigest, "program");
digest_type!(DraftDigest, "interaction draft");

pub(super) const fn valid_interaction_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    let mut index = 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-')) {
            return false;
        }
        index += 1;
    }
    true
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
