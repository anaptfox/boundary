//! The registry: what is reachable right now, and nothing else.
//!
//! Liveness is tied to the connection that registered a record. A host
//! registers when it installs and unregisters when it revokes; if it exits
//! without unregistering, closing its socket withdraws its records. That is
//! why there is no heartbeat protocol: the connection *is* the liveness
//! signal, and a process that has gone away cannot hold a socket open.
//!
//! A record may only be withdrawn by the connection that registered it. Every
//! connection belongs to the same OS user, so this is not a security boundary;
//! it stops one application from accidentally withdrawing another's address.

use std::collections::BTreeMap;

use boundary_reach::ReachRecord;

/// Identifies one live client connection.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectionId(pub u64);

/// Why a registry interaction was refused.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RegistryError {
    /// The record's own digest does not describe its content.
    #[error("reach record failed verification: {0}")]
    Invalid(String),
    /// No record is registered under that binding digest.
    #[error("no record is registered for binding digest {binding_digest}")]
    Unknown {
        /// The digest that was not found.
        binding_digest: String,
    },
    /// Another connection registered that record.
    #[error("binding digest {binding_digest} was registered by another connection")]
    NotOwned {
        /// The digest owned elsewhere.
        binding_digest: String,
    },
}

/// One registered entry.
#[derive(Clone, Debug)]
struct Entry {
    record: ReachRecord,
    owner: ConnectionId,
}

/// Reachable records for one OS user.
///
/// This is the entire state of the bus. It holds no authority, no invocation
/// context, and no history of calls.
#[derive(Debug, Default)]
pub struct Registry {
    entries: BTreeMap<String, Entry>,
}

impl Registry {
    /// Creates an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers or replaces a record for one binding digest.
    ///
    /// Re-registering the same digest replaces the record, which is how a host
    /// reissues an address after a deployment moves. Replacement requires the
    /// same owner, so a moved address cannot be claimed by another process.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::Invalid`] when the record's digest does not
    /// match its content, or [`RegistryError::NotOwned`] when another live
    /// connection registered that digest.
    pub fn register(
        &mut self,
        owner: ConnectionId,
        record: ReachRecord,
    ) -> Result<(), RegistryError> {
        record
            .verify()
            .map_err(|error| RegistryError::Invalid(error.to_string()))?;

        let digest = record.binding_digest().to_owned();
        if let Some(existing) = self.entries.get(&digest)
            && existing.owner != owner
        {
            return Err(RegistryError::NotOwned {
                binding_digest: digest,
            });
        }
        self.entries.insert(digest, Entry { record, owner });
        Ok(())
    }

    /// Withdraws one record.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::Unknown`] when nothing is registered under the
    /// digest, or [`RegistryError::NotOwned`] when another connection owns it.
    pub fn unregister(
        &mut self,
        owner: ConnectionId,
        binding_digest: &str,
    ) -> Result<(), RegistryError> {
        match self.entries.get(binding_digest) {
            None => Err(RegistryError::Unknown {
                binding_digest: binding_digest.to_owned(),
            }),
            Some(entry) if entry.owner != owner => Err(RegistryError::NotOwned {
                binding_digest: binding_digest.to_owned(),
            }),
            Some(_) => {
                self.entries.remove(binding_digest);
                Ok(())
            }
        }
    }

    /// Withdraws everything one connection registered.
    ///
    /// Called when a socket closes. A process that exited cannot hold a
    /// connection open, so this is what makes a stale address disappear
    /// without any liveness protocol.
    pub fn drop_connection(&mut self, owner: ConnectionId) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.owner != owner);
        before - self.entries.len()
    }

    /// Lists every reachable record, ordered by binding digest.
    #[must_use]
    pub fn list(&self) -> Vec<ReachRecord> {
        self.entries
            .values()
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// Returns how many records are registered.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether nothing is registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{ConnectionId, Registry, RegistryError};
    use boundary_reach::{ReachRecord, Transport};

    fn record(digest_byte: char, url: &str) -> ReachRecord {
        ReachRecord::new(
            format!("sha256:{}", String::from(digest_byte).repeat(64)),
            "deploy:example:1",
            [Transport::Http {
                url: url.to_owned(),
            }],
        )
        .expect("record")
    }

    #[test]
    fn a_registered_record_is_listed() -> Result<(), RegistryError> {
        let mut registry = Registry::new();
        registry.register(ConnectionId(1), record('1', "https://a.invalid/boundary"))?;
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.list().len(), 1);
        Ok(())
    }

    #[test]
    fn re_registering_replaces_rather_than_duplicates() -> Result<(), RegistryError> {
        let mut registry = Registry::new();
        let owner = ConnectionId(1);
        registry.register(owner, record('1', "https://a.invalid/boundary"))?;
        // The same Binding, reachable at a new address after a move.
        registry.register(owner, record('1', "https://b.invalid/boundary"))?;
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry.list()[0].transports(),
            [Transport::Http {
                url: "https://b.invalid/boundary".to_owned()
            }]
        );
        Ok(())
    }

    #[test]
    fn another_connection_cannot_claim_a_registered_binding() -> Result<(), RegistryError> {
        let mut registry = Registry::new();
        registry.register(ConnectionId(1), record('1', "https://a.invalid/boundary"))?;
        let error = registry
            .register(
                ConnectionId(2),
                record('1', "https://attacker.invalid/boundary"),
            )
            .expect_err("a second connection must not take over the address");
        assert!(matches!(error, RegistryError::NotOwned { .. }));
        assert_eq!(
            registry.list()[0].transports()[0],
            Transport::Http {
                url: "https://a.invalid/boundary".to_owned()
            }
        );
        Ok(())
    }

    #[test]
    fn another_connection_cannot_withdraw_a_record() -> Result<(), RegistryError> {
        let mut registry = Registry::new();
        let entry = record('1', "https://a.invalid/boundary");
        let digest = entry.binding_digest().to_owned();
        registry.register(ConnectionId(1), entry)?;
        let error = registry
            .unregister(ConnectionId(2), &digest)
            .expect_err("only the owner withdraws");
        assert!(matches!(error, RegistryError::NotOwned { .. }));
        assert_eq!(registry.len(), 1);
        Ok(())
    }

    #[test]
    fn withdrawing_something_unregistered_is_an_error_not_a_silent_success() {
        let mut registry = Registry::new();
        let error = registry
            .unregister(ConnectionId(1), "sha256:absent")
            .expect_err("must report the gap");
        assert!(matches!(error, RegistryError::Unknown { .. }));
    }

    #[test]
    fn closing_a_connection_withdraws_only_its_own_records() -> Result<(), RegistryError> {
        let mut registry = Registry::new();
        registry.register(ConnectionId(1), record('1', "https://a.invalid/boundary"))?;
        registry.register(ConnectionId(1), record('2', "https://b.invalid/boundary"))?;
        registry.register(ConnectionId(2), record('3', "https://c.invalid/boundary"))?;
        assert_eq!(registry.len(), 3);

        // The first host exits without unregistering. Its addresses go away;
        // the other host's does not.
        assert_eq!(registry.drop_connection(ConnectionId(1)), 2);
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry.list()[0].transports()[0],
            Transport::Http {
                url: "https://c.invalid/boundary".to_owned()
            }
        );
        Ok(())
    }

    #[test]
    fn a_record_whose_digest_does_not_match_its_content_is_refused() {
        let mut registry = Registry::new();
        let good = record('1', "https://a.invalid/boundary");
        let mut raw = serde_json::to_value(&good).expect("to value");
        raw["transports"][0]["url"] =
            serde_json::Value::String("https://evil.invalid/x".to_owned());
        let tampered: ReachRecord = serde_json::from_value(raw).expect("deserializes");

        let error = registry
            .register(ConnectionId(1), tampered)
            .expect_err("a record must describe itself");
        assert!(matches!(error, RegistryError::Invalid(_)));
        assert!(registry.is_empty());
    }
}
