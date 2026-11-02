//! The Reach record: where a Binding can be reached.
//!
//! Binding identity deliberately excludes routes and transport, so moving a
//! deployment must not change what was pinned. That leaves a gap: something has
//! to say where a surface actually is. A Reach record fills it without
//! reopening identity. It *references* a binding digest and is reissued when a
//! deployment moves; the Binding manifest never learns it exists.
//!
//! A Reach record is not authority. Holding one lets a caller find a surface
//! and fetch its manifest; the caller still binds atomically against that
//! manifest, and the host still admits every invocation. Nothing here carries
//! context, credentials, admission policy, or a grant. Handing someone a Reach
//! record is closer to giving out an address than a key.
//!
//! Records are unsigned in version 1. The signature field is reserved so
//! adding one later does not change the shape, and the digest already covers
//! everything a signature would need to bind.

use std::fmt::Write as _;

use boundary_core::canonical_json;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Identity domain for a Reach record.
const REACH_DOMAIN: &str = "boundary.reach/v1";

/// One way to reach a surface.
///
/// Kinds are closed in version 1. In-process reach needs no record, because a
/// caller in the same process already holds the Binding; a record exists
/// precisely to cross a boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Transport {
    /// A Unix domain socket on this machine. Trust is the OS user.
    Unix {
        /// Absolute socket path.
        path: String,
        /// Base path the two protocol routes hang beneath.
        base: String,
    },
    /// An HTTP origin serving the framing in specification section 6.
    Http {
        /// Absolute base URL, with no trailing slash. The two routes hang
        /// beneath it.
        url: String,
    },
}

impl Transport {
    /// A stable sort key, so a record's digest does not depend on the order a
    /// host happened to list its transports.
    fn sort_key(&self) -> (u8, &str, &str) {
        match self {
            Self::Unix { path, base } => (0, path.as_str(), base.as_str()),
            Self::Http { url } => (1, url.as_str(), ""),
        }
    }
}

/// Why a Reach record is invalid.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ReachError {
    /// A required field was empty.
    #[error("reach record field {field:?} must not be empty")]
    Empty {
        /// The offending field.
        field: &'static str,
    },
    /// A record listed no way to reach anything.
    #[error("a reach record must list at least one transport")]
    NoTransports,
    /// A transport address was not the shape its kind requires.
    #[error("transport address is invalid: {reason}")]
    Transport {
        /// What was wrong.
        reason: String,
    },
    /// Canonicalization failed while computing the digest.
    #[error("reach record could not be canonicalized: {0}")]
    Canonical(String),
}

/// Where one Binding can be reached.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachRecord {
    version: u8,
    binding_digest: String,
    installation_id: String,
    transports: Vec<Transport>,
    /// Reserved. Version 1 records are unsigned; local trust is the OS user
    /// and remote trust is the transport's own. The field exists so adding a
    /// signature later does not change the record shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signature: Option<Value>,
    reach_digest: String,
}

impl ReachRecord {
    /// Builds and validates a record, computing its digest.
    ///
    /// Transports are sorted, so two hosts listing the same addresses in a
    /// different order produce the same record.
    ///
    /// # Errors
    ///
    /// Returns [`ReachError`] when a field is empty, no transport is listed,
    /// or an address is malformed.
    pub fn new(
        binding_digest: impl Into<String>,
        installation_id: impl Into<String>,
        transports: impl IntoIterator<Item = Transport>,
    ) -> Result<Self, ReachError> {
        let binding_digest = binding_digest.into();
        let installation_id = installation_id.into();
        if binding_digest.trim().is_empty() {
            return Err(ReachError::Empty {
                field: "bindingDigest",
            });
        }
        if installation_id.trim().is_empty() {
            return Err(ReachError::Empty {
                field: "installationId",
            });
        }

        let mut transports: Vec<Transport> = transports.into_iter().collect();
        for transport in &transports {
            validate(transport)?;
        }
        transports.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
        transports.dedup();
        if transports.is_empty() {
            return Err(ReachError::NoTransports);
        }

        let mut record = Self {
            version: 1,
            binding_digest,
            installation_id,
            transports,
            signature: None,
            reach_digest: String::new(),
        };
        record.reach_digest = record.compute_digest()?;
        Ok(record)
    }

    /// Returns the binding digest this record points at.
    #[must_use]
    pub fn binding_digest(&self) -> &str {
        &self.binding_digest
    }

    /// Returns the live Installation identity this record was issued for.
    #[must_use]
    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    /// Returns the transports, sorted.
    #[must_use]
    pub fn transports(&self) -> &[Transport] {
        &self.transports
    }

    /// Returns this record's own digest.
    #[must_use]
    pub fn reach_digest(&self) -> &str {
        &self.reach_digest
    }

    /// Recomputes and checks the digest of a record that crossed a boundary.
    ///
    /// # Errors
    ///
    /// Returns [`ReachError`] when the record does not canonicalize or its
    /// recorded digest does not match its content.
    pub fn verify(&self) -> Result<(), ReachError> {
        let recomputed = self.compute_digest()?;
        if recomputed == self.reach_digest {
            Ok(())
        } else {
            Err(ReachError::Transport {
                reason: format!(
                    "reach digest mismatch: recorded {}, recomputed {recomputed}",
                    self.reach_digest
                ),
            })
        }
    }

    /// Hashes the identity-bearing fields.
    ///
    /// The signature is excluded, because a signature signs a digest and
    /// cannot be part of what it signs.
    fn compute_digest(&self) -> Result<String, ReachError> {
        let value = json!({
            "version": self.version,
            "bindingDigest": self.binding_digest,
            "installationId": self.installation_id,
            "transports": self.transports,
        });
        let canonical =
            canonical_json(&value).map_err(|error| ReachError::Canonical(error.to_string()))?;

        let mut hasher = Sha256::new();
        hasher.update(REACH_DOMAIN.as_bytes());
        hasher.update([0]);
        hasher.update(canonical.as_bytes());
        let digest: [u8; 32] = hasher.finalize().into();

        let mut out = String::with_capacity(7 + 64);
        out.push_str("sha256:");
        for byte in digest {
            let _ = write!(out, "{byte:02x}");
        }
        Ok(out)
    }
}

/// Characters a transport address may carry beyond ASCII alphanumerics.
///
/// A strict allowlist, not a denylist of what is dangerous today. A record
/// is handed between applications and is unsigned in version 1, so whoever
/// hands one over chooses the address a caller dials. Carriage return and
/// line feed would split one HTTP request into two on the wire; a space
/// would end the request line early; `?`, `#`, and `@` name url parts a
/// Reach base has no business carrying. Listing what is allowed means a
/// character nobody thought to deny cannot surprise a later sink.
///
/// `%` stays in: a base path may be percent-encoded, and nothing here
/// decodes it, so an encoded byte reaches the server as encoded text.
const ADDRESS_ALLOWED: &str = "-._~:/%";

/// Refuses any character outside [`ADDRESS_ALLOWED`] or ASCII alphanumerics.
fn validate_characters(field: &str, value: &str) -> Result<(), ReachError> {
    for (index, character) in value.char_indices() {
        if character.is_ascii_alphanumeric() || ADDRESS_ALLOWED.contains(character) {
            continue;
        }
        return Err(ReachError::Transport {
            reason: format!(
                "{field} may not contain {character:?} at byte {index}; an address is limited to ASCII alphanumerics and {ADDRESS_ALLOWED:?}"
            ),
        });
    }
    Ok(())
}

fn validate(transport: &Transport) -> Result<(), ReachError> {
    match transport {
        Transport::Unix { path, base } => {
            if !path.starts_with('/') {
                return Err(ReachError::Transport {
                    reason: format!("unix socket path must be absolute, got {path:?}"),
                });
            }
            validate_characters("unix socket path", path)?;
            validate_base(base)
        }
        Transport::Http { url } => {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(ReachError::Transport {
                    reason: format!("http url must name a scheme, got {url:?}"),
                });
            }
            if url.ends_with('/') {
                return Err(ReachError::Transport {
                    reason: "http url must not end with a slash; the routes supply it".to_owned(),
                });
            }
            validate_characters("http url", url)
        }
    }
}

fn validate_base(base: &str) -> Result<(), ReachError> {
    validate_characters("base path", base)?;
    if !base.starts_with('/') {
        return Err(ReachError::Transport {
            reason: format!("base path must be absolute, got {base:?}"),
        });
    }
    if base == "/" {
        return Err(ReachError::Transport {
            reason: "base path must not claim the application root".to_owned(),
        });
    }
    if base.ends_with('/') {
        return Err(ReachError::Transport {
            reason: "base path must not end with a slash".to_owned(),
        });
    }
    Ok(())
}
