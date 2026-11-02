//! Loading a plugin component and reading what it actually imports.
//!
//! The bind-time check reads imports from the component binary, not from the
//! world it claims to target. A world may list more than a component uses, and
//! a component may have been built against a different world entirely. Only
//! what the binary genuinely imports can be reached at runtime, so only that is
//! checked.
//!
//! Imports from outside the provided interface — `wasi:cli`, `wasi:clocks`, a
//! second Boundary interface — are unmapped by construction. Nothing needs to
//! special-case WASI: it is simply not provided.

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};
use wasmtime::Engine;
use wasmtime::component::Component;
use wasmtime::component::types::ComponentItem;

use crate::imports::{HostImports, ImportCheck};

/// Identity domain for a plugin realization. Mirrors the `boundary.*` domains the
/// program and lifecycle modules already use.
const REALIZATION_DOMAIN: &str = "boundary.wasm-realization/v1";

/// One import a component genuinely requires.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RequiredImport {
    /// The instance this import came from, such as `boundary:guest/footprints@1.0.0`.
    /// `None` for a bare top-level function import.
    pub instance: Option<String>,
    /// The imported function name.
    pub name: String,
}

impl RequiredImport {
    /// Renders the import the way a refusal report should name it.
    #[must_use]
    pub fn qualified(&self) -> String {
        match &self.instance {
            Some(instance) => format!("{instance}#{}", self.name),
            None => self.name.clone(),
        }
    }
}

/// Strips a package prefix and version from an interface name.
///
/// `boundary:guest/footprints@1.0.0` and `footprints` both reduce to `footprints`,
/// so an offer written in footprint terms matches a fully qualified WIT
/// instance name.
#[cfg(test)]
fn interface_base(name: &str) -> &str {
    let after_package = name.rsplit('/').next().unwrap_or(name);
    after_package.split('@').next().unwrap_or(after_package)
}

/// Why a component could not be loaded or bound.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PluginError {
    /// The component could not be made ready before any guest code ran: the
    /// bytes are not a valid component for this engine, or a declared host
    /// import does not match the provided import's exact signature,
    /// `(string) -> result<string, string>`. Certainty is `NotStarted`.
    #[error("component did not load: {0}")]
    Load(String),
    /// Guest startup began and then failed. A provided host import may
    /// already have performed an effect, so this is never evidence that
    /// nothing happened. Certainty is `Unknown`.
    #[error("component startup failed with unknown certainty: {reason}")]
    Startup {
        /// Why startup failed, including the runtime cause.
        reason: String,
    },
    /// The component imports something the host did not offer.
    #[error(
        "component imports {} name(s) the host did not offer: {}. Provided: {}",
        .unmapped.len(),
        .unmapped.join(", "),
        if .provided.is_empty() { "(nothing)".to_owned() } else { .provided.join(", ") }
    )]
    UnmappedImports {
        /// Every import outside the offer, sorted.
        unmapped: Vec<String>,
        /// What the host provided, sorted.
        provided: Vec<String>,
    },
}

impl PluginError {
    /// What this refusal proves about whether guest execution began.
    #[must_use]
    pub const fn certainty(&self) -> boundary_core::lifecycle::InvocationCertainty {
        use boundary_core::lifecycle::InvocationCertainty;
        match self {
            Self::Startup { .. } => InvocationCertainty::Unknown,
            Self::Load(_) | Self::UnmappedImports { .. } => InvocationCertainty::NotStarted,
        }
    }
}

/// How long one plugin guest instance lives.
///
/// This is part of a realization's identity, not a tuning knob. Two calls on
/// a per-call guest cannot observe each other; two calls on a persistent one
/// can, because guest heap state survives between them. A contract cannot
/// mention that state, so a host that opts into it is declaring a different
/// realization and gets a different realization id.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PluginLifetime {
    /// Every call runs on a fresh store and instance. Identical calls behave
    /// identically, and one caller's exhausted budget cannot cost another.
    /// The default.
    #[default]
    PerCall,
    /// The store persists across calls until a trap poisons it. Guest heap
    /// state can survive from call A to call B. Opt-in, and declared.
    Persistent,
}

impl PluginLifetime {
    /// The stable token that enters the realization id.
    #[must_use]
    pub const fn token(self) -> &'static str {
        match self {
            Self::PerCall => "per-call",
            Self::Persistent => "persistent",
        }
    }
}

/// A loaded plugin component and its content-derived identity.
///
/// Loading compiles the component once. A bound realization reuses this value
/// across calls rather than recompiling per invocation. Cloning is cheap —
/// `wasmtime::component::Component` is a handle to the compiled artifact, not
/// a copy of it — which is what lets a realization build a fresh store per
/// call, or after a trap, without recompiling.
#[derive(Clone)]
pub struct PluginComponent {
    component: Component,
    required: Vec<RequiredImport>,
    component_digest: String,
    realization_id: String,
    lifetime: PluginLifetime,
}

impl std::fmt::Debug for PluginComponent {
    /// Shows identity and required imports. The compiled component itself has
    /// no useful debug rendering and could be large.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginComponent")
            .field("realization_id", &self.realization_id)
            .field("component_digest", &self.component_digest)
            .field("lifetime", &self.lifetime)
            .field("required_imports", &self.required)
            .finish_non_exhaustive()
    }
}

impl PluginComponent {
    /// Loads a plugin component with the default per-call lifetime. See
    /// [`PluginComponent::load_with`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::Load`] when the bytes are not a valid component.
    pub fn load(engine: &Engine, bytes: &[u8], wit_digest: &str) -> Result<Self, PluginError> {
        Self::load_with(engine, bytes, wit_digest, PluginLifetime::PerCall)
    }

    /// Loads a component and derives its identity from its bytes, its world,
    /// and how long an instance of it lives.
    ///
    /// The realization id is content-addressed: the same bytes against the same
    /// world under the same lifetime always produce the same id, and different
    /// bytes never share one. A Binding manifest carrying this id therefore
    /// proves exactly which plugin was bound and whether its guest heap state can
    /// outlive a call.
    ///
    /// It does **not** prove what that guest could reach. The host imports is
    /// not an input here — it is not known until bind — so the same bytes
    /// bound under a narrow offer and a wide one share an id. Pair this with
    /// [`HostImports::authority_digest`](crate::HostImports::authority_digest)
    /// to answer both "which code ran" and "what could it reach"; either
    /// alone is half a receipt.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::Load`] when the bytes are not a valid component.
    pub fn load_with(
        engine: &Engine,
        bytes: &[u8],
        wit_digest: &str,
        lifetime: PluginLifetime,
    ) -> Result<Self, PluginError> {
        let component = Component::from_binary(engine, bytes)
            // `{:#}` keeps the validation cause, not just "failed to parse".
            .map_err(|error| PluginError::Load(format!("{error:#}")))?;
        let required = read_required_imports(engine, &component);

        let component_digest = digest_of(bytes);
        let mut hasher = Sha256::new();
        hasher.update(REALIZATION_DOMAIN.as_bytes());
        hasher.update([0]);
        hasher.update(component_digest.as_bytes());
        hasher.update([0]);
        hasher.update(wit_digest.as_bytes());
        hasher.update([0]);
        hasher.update(lifetime.token().as_bytes());
        let realization_id = encode(hasher.finalize().into());

        Ok(Self {
            component,
            required,
            component_digest,
            realization_id,
            lifetime,
        })
    }

    /// Returns how long an instance of this component lives.
    #[must_use]
    pub const fn lifetime(&self) -> PluginLifetime {
        self.lifetime
    }

    /// Returns the imports this component genuinely requires, sorted.
    #[must_use]
    pub fn required_imports(&self) -> &[RequiredImport] {
        &self.required
    }

    /// Returns the SHA-256 digest of the component bytes.
    #[must_use]
    pub fn component_digest(&self) -> &str {
        &self.component_digest
    }

    /// Returns the content-derived realization id.
    #[must_use]
    pub fn realization_id(&self) -> &str {
        &self.realization_id
    }

    /// Returns the compiled component.
    #[must_use]
    pub const fn component(&self) -> &Component {
        &self.component
    }

    /// Checks this component's actual imports against the host imports.
    #[must_use]
    pub fn check_imports(&self, offer: &HostImports) -> ImportCheck {
        let mut unmapped: BTreeSet<String> = BTreeSet::new();
        let mut used: BTreeSet<String> = BTreeSet::new();

        for import in &self.required {
            let in_offered_interface = import.instance.as_deref() == Some(offer.interface());

            if in_offered_interface && offer.contains(&import.name) {
                used.insert(import.name.clone());
            } else {
                // Anything outside the provided interface is unmapped by
                // construction. WASI needs no special case.
                unmapped.insert(import.qualified());
            }
        }

        if unmapped.is_empty() {
            ImportCheck::Satisfied {
                used: used.into_iter().collect(),
            }
        } else {
            ImportCheck::Refused {
                unmapped: unmapped.into_iter().collect(),
                provided: offer.wit_names(),
            }
        }
    }

    /// Checks imports and converts a refusal into an error.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::UnmappedImports`] when the component needs
    /// anything the host did not offer. The guest is never instantiated.
    pub fn require_provided(&self, offer: &HostImports) -> Result<Vec<String>, PluginError> {
        match self.check_imports(offer) {
            ImportCheck::Satisfied { used } => Ok(used),
            ImportCheck::Refused { unmapped, provided } => {
                Err(PluginError::UnmappedImports { unmapped, provided })
            }
        }
    }
}

/// Reads every function a component imports, descending one level into
/// instance imports because WIT interfaces arrive as instances.
fn read_required_imports(engine: &Engine, component: &Component) -> Vec<RequiredImport> {
    let mut out: Vec<RequiredImport> = Vec::new();
    for (name, item) in component.component_type().imports(engine) {
        match item.ty {
            ComponentItem::ComponentInstance(instance) => {
                for (function, _) in instance.exports(engine) {
                    out.push(RequiredImport {
                        instance: Some(name.to_owned()),
                        name: function.to_owned(),
                    });
                }
            }
            ComponentItem::ComponentFunc(_) | ComponentItem::CoreFunc(_) => {
                out.push(RequiredImport {
                    instance: None,
                    name: name.to_owned(),
                });
            }
            // Module, Component, and Type imports carry no callable authority
            // on their own; a component that needs one still reaches functions
            // through an instance, which the arms above already record.
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

fn digest_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode(hasher.finalize().into())
}

/// Renders a digest the way every other Boundary identity is rendered.
fn encode(digest: [u8; 32]) -> String {
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::interface_base;

    #[test]
    fn interface_base_is_not_used_for_offer_comparison() {
        // Kept as a named helper for diagnostics. Bind compares the full
        // instance name, including package and version, so a guest built
        // against footprints@9.9.9 cannot silently bind as footprints@1.0.0.
        assert_eq!(
            interface_base("boundary:guest/footprints@1.0.0"),
            "footprints"
        );
        assert_eq!(
            interface_base("boundary:guest/footprints@9.9.9"),
            "footprints"
        );
        assert_ne!(
            "boundary:guest/footprints@1.0.0", "boundary:guest/footprints@9.9.9",
            "version is part of declared identity"
        );
    }
}
