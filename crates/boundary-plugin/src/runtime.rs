//! Instantiating a guest under limits and calling one interaction.
//!
//! Three rules are enforced here rather than documented and hoped for.
//!
//! - **The context never crosses.** A host function is a closure that captures
//!   whatever it needs on the host side. The guest passes and receives JSON and
//!   nothing else, so there is no path by which an opaque invocation context
//!   could be serialized into a component.
//! - **Limits are not optional.** Every instance is created with a fuel budget
//!   and a memory ceiling. There is no constructor that skips them.
//! - **A trap is not a domain error.** An `err` payload is a declared interaction
//!   error and a domain outcome. A trap, an exhausted budget, or a malformed
//!   reply is an infrastructure fault whose certainty is `Unknown`, and it is
//!   never reclassified as a declared error.
//!
//! A fault carries the same [`InvocationCertainty`] a Binding outcome does.
//! One vocabulary: a guest that trapped and a native dispatcher that threw
//! report the same `Unknown`, and a realization that provably never ran
//! reports the same `NotStarted`.

use std::collections::BTreeMap;
use std::sync::Arc;

use boundary_core::lifecycle::InvocationCertainty;
use wasmtime::component::{InstancePre, Val};
use wasmtime::{Engine, ResourceLimiter, Store};

use crate::component::{PluginComponent, PluginError};
use crate::imports::HostImports;
use crate::limits::{GuestLimits, GuestState};
use crate::name::NameError;

#[path = "runtime_linker.rs"]
mod linking;

/// A host function backing one footprint.
///
/// It takes the guest's JSON request and returns either a JSON reply or a JSON
/// declared error. It closes over host state; nothing about the invocation
/// context reaches the guest.
pub type HostFunction = Arc<dyn Fn(&str) -> HostReply + Send + Sync>;

/// What a host function has to say about one guest request.
///
/// Three arms, not two. The WIT profile carries `result<string, string>`, so
/// the wire has room for a reply and a declared error and nothing else — and a
/// host function that started an effect and cannot confirm it has to pick one
/// of them. Picking `err` hands the guest an ordinary declared error, which it
/// may legitimately catch and flatten into `ok`: an uncertain effect reported
/// as a definite success, which is exactly the flattening value 3 forbids.
///
/// [`HostReply::Unknown`] is the third answer. It does not cross the wire,
/// because there is nowhere to put it: it stops the call instead. The guest
/// traps, and the invocation becomes a [`GuestOutcome::Fault`] with
/// [`InvocationCertainty::Unknown`] — which is the truth. A guest cannot catch it and cannot
/// downgrade it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostReply {
    /// The host function returned output, as JSON text.
    Returned(String),
    /// The host function returned a declared interaction error, as JSON text.
    /// A domain outcome the guest may legitimately handle.
    DeclaredError(String),
    /// The host function may have started an effect and cannot say whether it
    /// completed. Not a domain outcome, and not the guest's to interpret.
    Unknown(String),
}

impl HostReply {
    /// Convenience for a host function that has no uncertain arm.
    #[must_use]
    pub fn from_result(result: Result<String, String>) -> Self {
        match result {
            Ok(payload) => Self::Returned(payload),
            Err(payload) => Self::DeclaredError(payload),
        }
    }
}

/// Host functions provided to a guest, paired with the names they answer to.
///
/// This is the executable half of an [`HostImports`]. The declared imports stay pure data
/// so it can be compared and reported; the functions live here.
#[derive(Clone, Default)]
pub struct HostFunctions {
    functions: BTreeMap<String, HostFunction>,
    /// WIT name back to the footprint that claimed it, so a collision can
    /// name both sides instead of silently replacing one.
    sources: BTreeMap<String, String>,
}

impl std::fmt::Debug for HostFunctions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostFunctions")
            .field("provided", &self.functions.keys().collect::<Vec<_>>())
            // The functions themselves have no useful rendering; the names
            // they answer to and the footprints that claimed them do.
            .field("sources", &self.sources)
            .finish_non_exhaustive()
    }
}

impl HostFunctions {
    /// Creates an empty set. A guest given this can reach nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Backs one footprint with a host function.
    ///
    /// # Errors
    ///
    /// Returns [`NameError`] when the footprint has no WIT spelling.
    pub fn provide(
        mut self,
        footprint: &str,
        function: impl Fn(&str) -> HostReply + Send + Sync + 'static,
    ) -> Result<Self, NameError> {
        let wit_name = crate::wit_identifier(footprint)?;
        // Distinct footprints can derive one WIT name (`a.bC` and `a.b-c`
        // both give `a-b-c`). Inserting over the first would leave the host
        // believing it provided two capabilities while the guest reaches
        // whichever was provided last — a read-class footprint replaced by a
        // change-class one, with nothing reported.
        if let Some(existing) = self.sources.get(&wit_name)
            && existing != footprint
        {
            return Err(NameError {
                interaction_id: footprint.to_owned(),
                derived: Some(wit_name),
                kind: crate::NameErrorKind::Collision {
                    with: existing.clone(),
                },
            });
        }
        self.sources.insert(wit_name.clone(), footprint.to_owned());
        self.functions.insert(wit_name, Arc::new(function));
        Ok(self)
    }

    /// Derives the declared imports these functions represent.
    #[must_use]
    pub fn declared_imports(&self, interface: &str) -> HostImports {
        self.functions
            .keys()
            .fold(HostImports::new(interface), |offer, wit_name| {
                // Names already passed derivation, so this cannot fail.
                offer.provide_wit_name(wit_name)
            })
    }

    /// Returns the function backing one WIT name.
    #[must_use]
    pub fn get(&self, wit_name: &str) -> Option<&HostFunction> {
        self.functions.get(wit_name)
    }
}

/// What one guest call produced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuestOutcome {
    /// The guest returned output. The payload is unvalidated JSON text; the
    /// caller validates it against the interaction's output contract.
    Returned(String),
    /// The guest returned a declared interaction error, as JSON text.
    DeclaredError(String),
    /// Execution failed. This is never a declared error.
    ///
    /// `certainty` says what is known about the consequence, in the same
    /// vocabulary a Binding outcome uses:
    ///
    /// - [`InvocationCertainty::Unknown`]: a trap, an exhausted budget, or a
    ///   reply that was not the expected shape. The guest may already have
    ///   reached a host function, so this is never evidence that nothing
    ///   happened.
    /// - [`InvocationCertainty::NotStarted`]: the call never began, and that
    ///   is known rather than suspected — the realization could not be made
    ///   ready to run it. Reporting that as unknown would manufacture
    ///   uncertainty a caller then has to reconcile, the inverse of the hazard
    ///   `Unknown` exists to avoid.
    Fault {
        /// What is known about the consequence.
        certainty: InvocationCertainty,
        /// Why the call failed.
        reason: String,
    },
}

impl GuestOutcome {
    fn unknown(reason: impl Into<String>) -> Self {
        Self::Fault {
            certainty: InvocationCertainty::Unknown,
            reason: reason.into(),
        }
    }

    fn not_started(reason: impl Into<String>) -> Self {
        Self::Fault {
            certainty: InvocationCertainty::NotStarted,
            reason: reason.into(),
        }
    }

    /// Returns whether this call failed, with any certainty.
    #[must_use]
    pub const fn is_fault(&self) -> bool {
        matches!(self, Self::Fault { .. })
    }

    /// Returns the certainty of a fault, or `None` for a returned value or a
    /// declared error (both of which completed).
    #[must_use]
    pub const fn certainty(&self) -> Option<InvocationCertainty> {
        match self {
            Self::Fault { certainty, .. } => Some(*certainty),
            Self::Returned(_) | Self::DeclaredError(_) => None,
        }
    }

    /// Returns whether this call provably never ran.
    #[must_use]
    pub const fn is_not_started(&self) -> bool {
        matches!(
            self,
            Self::Fault {
                certainty: InvocationCertainty::NotStarted,
                ..
            }
        )
    }
}

/// Everything needed to build a store and instance, kept so one can be built
/// again. A per-call guest builds one for every call; a persistent guest
/// builds one after a trap, because wasmtime refuses to re-enter the instance
/// for the life of a poisoned store, and without this a single trap would end
/// the realization for every later caller.
struct Blueprint {
    engine: Engine,
    linked: InstancePre<GuestState>,
    guest: PluginComponent,
    imports: HostFunctions,
    interface: String,
    limits: GuestLimits,
}

/// One bound guest realization: a component, host functions, and limits,
/// plus whatever store the lifetime says may be reused.
pub struct GuestInstance {
    /// Absent after a fault or while replacing a spent per-call store.
    live: Option<(Store<GuestState>, wasmtime::component::Instance)>,
    blueprint: Blueprint,
    /// True until the current store has served a call. A per-call guest
    /// spends its first store on its first call and builds a new one for
    /// each call after, so instantiation at bind is never wasted.
    fresh: bool,
}

impl GuestInstance {
    /// Checks imports, then instantiates the guest under `limits`.
    ///
    /// Compilation happened at load; this builds a store and instance. Under
    /// the default [`PluginLifetime::PerCall`](crate::PluginLifetime::PerCall)
    /// every later call builds its own. Under `Persistent` this store serves
    /// every call until a trap poisons it.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::UnmappedImports`] when the component needs
    /// anything the host did not provide, before any guest code runs. Returns
    /// [`PluginError::Load`] when a declared import does not match the
    /// provided import's exact signature, also before any guest code runs.
    /// Returns [`PluginError::Startup`] when guest startup began and failed;
    /// its certainty is `Unknown`.
    pub fn instantiate(
        engine: &Engine,
        guest: &PluginComponent,
        imports: &HostFunctions,
        interface: &str,
        limits: GuestLimits,
    ) -> Result<Self, PluginError> {
        let blueprint = Blueprint {
            engine: engine.clone(),
            linked: linking::prepare(engine, guest, imports, interface)?,
            guest: guest.clone(),
            imports: imports.clone(),
            interface: interface.to_owned(),
            limits,
        };
        let (store, instance) = blueprint.build(&mut false)?;
        Ok(Self {
            live: Some((store, instance)),
            blueprint,
            fresh: true,
        })
    }
}

impl Blueprint {
    /// Checks imports, then builds a fresh store and instance.
    ///
    /// Called once at bind and again whenever a trap has poisoned the store.
    /// The import check runs every time: rebuilding must not become a way to
    /// re-enter with an offer nobody re-checked.
    fn build(
        &self,
        execution_started: &mut bool,
    ) -> Result<(Store<GuestState>, wasmtime::component::Instance), PluginError> {
        let Self {
            engine,
            linked,
            guest,
            imports,
            interface,
            limits,
        } = self;
        let limits = *limits;
        guest.require_provided(&imports.declared_imports(interface))?;

        let mut store = Store::new(engine, GuestState::new(limits));
        store.limiter(|state| state as &mut dyn ResourceLimiter);
        store
            .set_fuel(limits.startup_fuel)
            .map_err(|error| PluginError::Load(format!("fuel budget rejected: {error}")))?;

        // Core start functions can execute host imports during instantiation.
        *execution_started = true;
        let instance = linked
            .instantiate(&mut store)
            .map_err(|error| PluginError::Startup {
                reason: format!("{error:#}"),
            })?;

        Ok((store, instance))
    }
}

impl GuestInstance {
    /// Calls one exported interaction by its WIT name.
    ///
    /// A missing export is a fault rather than a panic: a component that does
    /// not export what its world promised is a broken realization, and the
    /// consequence of that is unknown like any other fault.
    ///
    /// Under the default per-call lifetime every call after the first runs on
    /// a store built for it, so identical calls behave identically and guest
    /// heap state never leaks from one caller to the next. Under a persistent
    /// lifetime the store is reused, and only a trap forces a rebuild:
    /// wasmtime marks a store permanently on any trap and refuses to re-enter
    /// it, so one exhausted budget would otherwise brick the guest for every
    /// later caller — and each of those dead calls would report an unknown
    /// consequence for an effect that provably never started. Guest heap
    /// state does not survive that rebuild either; a caller that relied on
    /// state from before the trap is reading a fresh instance, which is the
    /// honest outcome given the trapped one is unusable.
    pub fn call(&mut self, wit_name: &str, input: &str) -> GuestOutcome {
        let per_call = self.blueprint.guest.lifetime() == crate::PluginLifetime::PerCall;
        if self.live.is_none() || (per_call && !self.fresh) {
            // Release the old heap before allocating its successor. A failed
            // rebuild leaves no spent or poisoned store available for reuse.
            self.live = None;
            let mut execution_started = false;
            match self.blueprint.build(&mut execution_started) {
                Ok(live) => self.live = Some(live),
                Err(error) => {
                    let reason =
                        format!("the realization could not be rebuilt for this call: {error}");
                    return if execution_started {
                        GuestOutcome::unknown(reason)
                    } else {
                        GuestOutcome::not_started(reason)
                    };
                }
            }
        }
        self.fresh = false;

        let Some((store, instance)) = self.live.as_mut() else {
            return GuestOutcome::not_started("the realization has no live store");
        };

        // Refill for this call so one exhausting call does not silently starve
        // the next. Each invocation gets the same budget.
        if let Err(error) = store.set_fuel(self.blueprint.limits.call_fuel) {
            return GuestOutcome::unknown(format!("fuel budget rejected: {error}"));
        }

        // Each call gets the whole copy budget, like its fuel.
        store.data_mut().reset_hostcall_budget();

        let Some(function) = instance.get_func(&mut *store, wit_name) else {
            return GuestOutcome::unknown(format!("guest does not export {wit_name:?}"));
        };

        let mut results = [Val::Bool(false)];
        let arguments = [Val::String(input.to_owned())];
        if let Err(error) = function.call(&mut *store, &arguments, &mut results) {
            // Traps land here, including fuel exhaustion and memory refusal.
            // The consequence is unknown: the guest may already have reached a
            // host function before it trapped. The store is now poisoned, so
            // the next call rebuilds rather than inheriting this one's death.
            self.live = None;
            // Keep the cause as well as Wasmtime's execution backtrace so a
            // host can distinguish exhausted fuel from another guest trap.
            return GuestOutcome::unknown(format!("{error:#}"));
        }
        match results.into_iter().next() {
            Some(Val::Result(Ok(payload))) => match payload.map(|value| *value) {
                Some(Val::String(text)) => GuestOutcome::Returned(text),
                _ => GuestOutcome::unknown("guest returned ok without a string payload"),
            },
            Some(Val::Result(Err(payload))) => match payload.map(|value| *value) {
                Some(Val::String(text)) => GuestOutcome::DeclaredError(text),
                _ => GuestOutcome::unknown("guest returned err without a string payload"),
            },
            other => {
                GuestOutcome::unknown(format!("guest returned an unexpected shape: {other:?}"))
            }
        }
    }

    /// Returns fuel remaining in the live store.
    ///
    /// Returns `None` after a trap or failed rebuild releases that store.
    #[must_use]
    pub fn fuel_remaining(&self) -> Option<u64> {
        self.live.as_ref()?.0.get_fuel().ok()
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
