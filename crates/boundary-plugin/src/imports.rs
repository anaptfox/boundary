//! The host-authored host imports and the bind-time subset check.
//!
//! This is where a declared footprint stops being advisory. For a native
//! handler, `reads` and `changes` are a claim the implementation makes about
//! itself and nothing enforces them. For a guest, the host decides which
//! functions exist at all, and a component that imports anything outside that
//! decision cannot be instantiated.
//!
//! Be precise about what that buys. The check enforces **absence**: a guest
//! with no `publications` import cannot reach publications, and that is
//! structural rather than policy. It does not enforce that a guest holding a
//! `publications` import stays within its declared change class — the host
//! function backing a footprint must honor its own class, exactly the review
//! obligation a native handler already carries.
//!
//! The map is authored by the host, never derived from footprints. Deriving it
//! would turn footprint strings into authority, and a declaration must never
//! grant what it merely describes.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use sha2::{Digest, Sha256};

/// Identity domain for an offer digest.
const AUTHORITY_DOMAIN: &str = "boundary.wasm-authority/v1";

/// One footprint the host is willing to back with a function.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostImport {
    /// The footprint name, matching a `reads` or `changes` entry.
    pub footprint: String,
    /// The WIT function name inside the imports interface.
    pub wit_name: String,
}

/// The complete set of imports a host provides one guest.
///
/// Construct it explicitly. There is deliberately no constructor that reads a
/// Program and provides every footprint it declares: choosing what to hand a
/// guest is the host's decision, and making it automatic would collapse
/// declaration into authority.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostImports {
    interface: String,
    entries: BTreeMap<String, HostImport>,
}

impl HostImports {
    /// Creates an empty offer for one imports interface.
    ///
    /// An empty offer is meaningful and is the right default for a guest that
    /// only computes: it can reach nothing at all.
    #[must_use]
    pub fn new(interface: impl Into<String>) -> Self {
        Self {
            interface: interface.into(),
            entries: BTreeMap::new(),
        }
    }

    /// Provides one footprint under its derived WIT name.
    ///
    /// # Errors
    ///
    /// Returns [`crate::NameError`] when the footprint has no WIT spelling.
    pub fn provide(mut self, footprint: impl Into<String>) -> Result<Self, crate::NameError> {
        let footprint = footprint.into();
        let wit_name = crate::wit_identifier(&footprint)?;
        self.entries.insert(
            wit_name.clone(),
            HostImport {
                footprint,
                wit_name,
            },
        );
        Ok(self)
    }

    /// Provides a WIT name that was already derived from a footprint.
    ///
    /// Used where derivation has already succeeded, so there is nothing left to
    /// fail. The footprint is recorded as the name itself.
    #[must_use]
    pub fn provide_wit_name(mut self, wit_name: &str) -> Self {
        self.entries.insert(
            wit_name.to_owned(),
            HostImport {
                footprint: wit_name.to_owned(),
                wit_name: wit_name.to_owned(),
            },
        );
        self
    }

    /// Returns the imports interface name this offer applies to.
    #[must_use]
    pub fn interface(&self) -> &str {
        &self.interface
    }

    /// Returns the provided WIT names, sorted.
    #[must_use]
    pub fn wit_names(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    /// Digests exactly what this offer grants: the interface it is scoped to
    /// and every WIT name inside it, sorted.
    ///
    /// A guest's realization id answers "which bytes ran". It cannot answer
    /// "what could they reach", because the offer is not one of its inputs —
    /// the same component bound with `{images}` and with
    /// `{images, publications, secrets}` is byte-identical. A receipt that
    /// names only the realization tells a reader which code ran and nothing
    /// about its authority, and a host that quietly widened an offer would
    /// produce no identity change at all. This digest is the missing half:
    /// carry it beside the realization id and the pair answers both
    /// questions.
    ///
    /// The interface name is included in full, package and version and all,
    /// because `boundary:guest/footprints@1.0.0` and `@9.9.9` are different
    /// interfaces and bind already treats them as such.
    #[must_use]
    pub fn authority_digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(AUTHORITY_DOMAIN.as_bytes());
        hasher.update([0]);
        hasher.update(self.interface.as_bytes());
        for wit_name in self.entries.keys() {
            hasher.update([0]);
            hasher.update(wit_name.as_bytes());
        }
        let digest: [u8; 32] = hasher.finalize().into();
        let mut out = String::with_capacity(7 + 64);
        out.push_str("sha256:");
        for byte in digest {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    /// Returns the provided footprints, sorted by WIT name.
    #[must_use]
    pub fn footprints(&self) -> Vec<String> {
        self.entries
            .values()
            .map(|entry| entry.footprint.clone())
            .collect()
    }

    /// Returns whether this offer contains a WIT name.
    #[must_use]
    pub fn contains(&self, wit_name: &str) -> bool {
        self.entries.contains_key(wit_name)
    }

    /// Checks one component's actual imports against this offer.
    ///
    /// `required` is what the component genuinely imports, read from the
    /// component binary rather than from its declared world. A world may list
    /// more than a component uses; only actual imports are checked, and only
    /// actual imports can be reached.
    #[must_use]
    #[allow(dead_code)]
    pub(crate) fn check<'names>(
        &self,
        required: impl IntoIterator<Item = &'names str>,
    ) -> ImportCheck {
        let required: BTreeSet<String> = required.into_iter().map(ToOwned::to_owned).collect();
        let unmapped: Vec<String> = required
            .iter()
            .filter(|name| !self.entries.contains_key(*name))
            .cloned()
            .collect();

        if unmapped.is_empty() {
            ImportCheck::Satisfied {
                used: required.into_iter().collect(),
            }
        } else {
            ImportCheck::Refused {
                unmapped,
                provided: self.wit_names(),
            }
        }
    }
}

/// The outcome of checking a component's imports against the host imports.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportCheck {
    /// Every import the component needs is provided.
    Satisfied {
        /// The imports the component actually uses, sorted.
        used: Vec<String>,
    },
    /// The component imports something the host did not offer. This is a
    /// refusal to bind, not a runtime denial: the guest never runs.
    Refused {
        /// Imports the component needs that the host did not offer, sorted.
        unmapped: Vec<String>,
        /// What the host did offer, sorted, so the report is actionable.
        provided: Vec<String>,
    },
}

impl ImportCheck {
    /// Returns whether the component may be instantiated.
    #[must_use]
    pub const fn is_satisfied(&self) -> bool {
        matches!(self, Self::Satisfied { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::{HostImports, ImportCheck};
    use crate::NameError;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn host_imports() -> Result<HostImports, NameError> {
        HostImports::new("boundary:guest/footprints@1.0.0")
            .provide("images")?
            .provide("thumbnails")
    }

    #[test]
    fn an_empty_offer_refuses_any_import() {
        assert_eq!(
            HostImports::new("boundary:guest/footprints@1.0.0").check(["images"]),
            ImportCheck::Refused {
                unmapped: names(&["images"]),
                provided: Vec::new(),
            }
        );
    }

    #[test]
    fn empty_host_imports_admit_a_guest_that_imports_nothing() {
        assert_eq!(
            HostImports::new("boundary:guest/footprints@1.0.0").check([]),
            ImportCheck::Satisfied { used: Vec::new() }
        );
    }

    #[test]
    fn a_subset_is_satisfied() -> Result<(), NameError> {
        assert_eq!(
            host_imports()?.check(["images"]),
            ImportCheck::Satisfied {
                used: names(&["images"])
            }
        );
        Ok(())
    }

    #[test]
    fn an_unmapped_import_is_refused_with_an_actionable_report() -> Result<(), NameError> {
        assert_eq!(
            host_imports()?.check(["images", "publications"]),
            ImportCheck::Refused {
                unmapped: names(&["publications"]),
                provided: names(&["images", "thumbnails"]),
            },
            "the refusal names what was provided so the gap is obvious"
        );
        Ok(())
    }

    #[test]
    fn every_unmapped_import_is_reported_not_just_the_first() -> Result<(), NameError> {
        assert_eq!(
            host_imports()?.check(["publications", "secrets"]),
            ImportCheck::Refused {
                unmapped: names(&["publications", "secrets"]),
                provided: names(&["images", "thumbnails"]),
            }
        );
        Ok(())
    }
}
