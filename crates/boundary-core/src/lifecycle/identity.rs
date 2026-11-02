use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// A host-issued identity for one live installation.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct InstallationId(String);

/// A host-issued identity for one direct or request realization.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RealizationId(String);

/// Stable identity of one selected, unrealized projection surface.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ProjectionDigest(String);

/// Stable identity of one immutable installation manifest.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct InstallationDigest(String);

/// Stable identity of one complete projection binding manifest.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BindingDigest(String);

/// Stable identity of the control contract behind a request realization.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RequestControlDigest(String);

/// Invalid lifecycle identity.
#[derive(Debug, Error)]
#[error("{kind} must be a non-empty stable ASCII token")]
pub struct LifecycleIdentityError {
    kind: &'static str,
}

/// Invalid lifecycle artifact digest.
#[derive(Debug, Error)]
#[error("{kind} digest must be sha256: followed by 64 lowercase hexadecimal digits")]
pub struct LifecycleDigestError {
    kind: &'static str,
}

fn validate(value: String, kind: &'static str) -> Result<String, LifecycleIdentityError> {
    let bytes = value.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 256
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b':' | b'/' | b'-')
        });
    if !valid {
        return Err(LifecycleIdentityError { kind });
    }
    Ok(value)
}

macro_rules! lifecycle_id {
    ($name:ident, $kind:literal) => {
        impl $name {
            /// Validates a host-issued identity.
            ///
            /// # Errors
            ///
            /// Returns [`LifecycleIdentityError`] for an empty, oversized, or
            /// control-bearing value.
            pub fn new(value: impl Into<String>) -> Result<Self, LifecycleIdentityError> {
                validate(value.into(), $kind).map(Self)
            }

            /// Returns the host-issued identity text.
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

        impl FromStr for $name {
            type Err = LifecycleIdentityError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
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

lifecycle_id!(InstallationId, "installation identity");
lifecycle_id!(RealizationId, "realization identity");

macro_rules! lifecycle_digest {
    ($name:ident, $kind:literal) => {
        impl $name {
            /// Parses a lowercase `sha256:<hex>` lifecycle artifact digest.
            ///
            /// # Errors
            ///
            /// Returns [`LifecycleDigestError`] unless the value is exactly
            /// `sha256:` plus 64 lowercase hexadecimal digits.
            pub fn parse(value: impl AsRef<str>) -> Result<Self, LifecycleDigestError> {
                let value = value.as_ref();
                let valid = value.len() == 71
                    && value.starts_with("sha256:")
                    && value.as_bytes()[7..]
                        .iter()
                        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
                if !valid {
                    return Err(LifecycleDigestError { kind: $kind });
                }
                Ok(Self(value.to_owned()))
            }

            /// Returns the encoded lifecycle artifact digest.
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

lifecycle_digest!(ProjectionDigest, "projection");
lifecycle_digest!(InstallationDigest, "installation");
lifecycle_digest!(BindingDigest, "binding");
lifecycle_digest!(RequestControlDigest, "request control");

macro_rules! hashed_lifecycle_digest {
    ($name:ident) => {
        impl $name {
            pub(super) fn from_hash(bytes: [u8; 32]) -> Self {
                Self(encode_hash(bytes))
            }
        }
    };
}

hashed_lifecycle_digest!(ProjectionDigest);
hashed_lifecycle_digest!(InstallationDigest);
hashed_lifecycle_digest!(BindingDigest);

pub(super) fn encode_hash(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(71);
    value.push_str("sha256:");
    for byte in bytes {
        value.push(char::from(HEX[usize::from(byte >> 4)]));
        value.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    value
}
