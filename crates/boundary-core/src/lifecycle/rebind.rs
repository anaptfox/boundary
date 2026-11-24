use std::sync::{Arc, RwLock};

use super::identity::BindingDigest;
use super::{
    Admission, BindResult, Binding, BindingController, BindingManifest, Bound, Installation,
    Projection, UnrealizedReport, bind,
};

/// A newly realized binding and the lifecycle result for its predecessor.
pub struct Rebound<C: Sync + ?Sized, A> {
    /// The newly bound live capability and its lifecycle controller.
    pub bound: Bound<C, A>,
    /// Stable identity of the binding that was replaced.
    pub previous_binding_digest: BindingDigest,
    /// Whether this operation changed the previous binding from live to revoked.
    pub previous_revoked: bool,
}

/// Result of atomically replacing a binding.
pub enum RebindResult<C: Sync + ?Sized, A> {
    /// The replacement succeeded and the previous controller was revoked.
    Rebound(Box<Rebound<C, A>>),
    /// The replacement failed; the prior binding remains untouched.
    Unrealized {
        /// Why the requested replacement could not be realized.
        report: UnrealizedReport,
        /// Stable identity of the binding that was retained.
        previous_binding_digest: BindingDigest,
        /// Whether the previous binding remained live at the time checked.
        previous_preserved: bool,
    },
}

/// Binds a replacement before revoking the previous binding.
///
/// If the replacement cannot be realized, the previous controller is not
/// changed. On success, the previous binding is revoked after the replacement
/// has been fully constructed.
#[must_use]
pub fn rebind<C, A>(
    projection: &Projection,
    previous_binding_digest: BindingDigest,
    previous_controller: &BindingController,
    next_installation: &Installation<C>,
    admission: A,
) -> RebindResult<C, A>
where
    C: Sync + ?Sized + 'static,
    A: Admission<C>,
{
    match bind(projection, next_installation, admission) {
        BindResult::Bound(bound) => {
            let previous_revoked = previous_controller.revoke();
            RebindResult::Rebound(Box::new(Rebound {
                bound: *bound,
                previous_binding_digest,
                previous_revoked,
            }))
        }
        BindResult::Unrealized(report) => RebindResult::Unrealized {
            report,
            previous_binding_digest,
            previous_preserved: !previous_controller.revoked(),
        },
    }
}

/// Outcome details for a successful slot transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebindTransition {
    /// Stable identity of the binding that was replaced.
    pub previous_binding_digest: BindingDigest,
    /// Stable identity of the new active binding.
    pub next_binding_digest: BindingDigest,
    /// Whether the previous controller changed from live to revoked.
    pub previous_revoked: bool,
}

struct SlotState<C: Sync + ?Sized, A> {
    binding: Arc<Binding<C, A>>,
    controller: BindingController,
    projection: Projection,
}

/// Thread-safe owner of one explicitly active binding and its projection.
pub struct BindingSlot<C: Sync + ?Sized, A> {
    state: RwLock<SlotState<C, A>>,
}

impl<C: Sync + ?Sized, A> BindingSlot<C, A> {
    /// Creates a slot from a live binding and its durable projection.
    #[must_use]
    pub fn new(projection: Projection, bound: Bound<C, A>) -> Self {
        Self {
            state: RwLock::new(SlotState {
                binding: Arc::new(bound.binding),
                controller: bound.controller,
                projection,
            }),
        }
    }

    /// Returns a shared handle to the active binding.
    #[must_use]
    pub fn current(&self) -> Arc<Binding<C, A>> {
        Arc::clone(&self.read().binding)
    }

    /// Returns the durable projection currently paired with the active binding.
    #[must_use]
    pub fn projection(&self) -> Projection {
        self.read().projection.clone()
    }

    /// Returns the active binding's data-only manifest snapshot.
    #[must_use]
    pub fn manifest(&self) -> BindingManifest {
        self.read().binding.manifest().clone()
    }

    /// Returns whether the active binding's controller is revoked.
    #[must_use]
    pub fn revoked(&self) -> bool {
        self.read().controller.revoked()
    }

    /// Revokes the active binding.
    ///
    /// Returns true only for the transition from live to revoked.
    #[must_use]
    pub fn revoke(&self) -> bool {
        self.read().controller.revoke()
    }

    /// Rebinds the current projection against a new installation.
    ///
    /// On failure, the active binding and projection remain unchanged.
    ///
    /// # Errors
    ///
    /// Returns the unrealized report when the projection cannot be bound to
    /// the supplied installation.
    #[allow(clippy::result_large_err)]
    pub fn rebind(
        &self,
        next_installation: &Installation<C>,
        admission: A,
    ) -> Result<RebindTransition, UnrealizedReport>
    where
        C: 'static,
        A: Admission<C>,
    {
        self.rebind_projection_inner(None, next_installation, admission)
    }

    /// Rebinds an explicitly supplied projection against a new installation.
    ///
    /// On failure, the active binding and projection remain unchanged.
    ///
    /// # Errors
    ///
    /// Returns the unrealized report when the projection cannot be bound to
    /// the supplied installation.
    #[allow(clippy::result_large_err)]
    pub fn rebind_projection(
        &self,
        next_projection: Projection,
        next_installation: &Installation<C>,
        admission: A,
    ) -> Result<RebindTransition, UnrealizedReport>
    where
        C: 'static,
        A: Admission<C>,
    {
        self.rebind_projection_inner(Some(next_projection), next_installation, admission)
    }

    #[allow(clippy::result_large_err)]
    fn rebind_projection_inner(
        &self,
        next_projection: Option<Projection>,
        next_installation: &Installation<C>,
        admission: A,
    ) -> Result<RebindTransition, UnrealizedReport>
    where
        C: 'static,
        A: Admission<C>,
    {
        let mut state = self.write();
        let projection = next_projection.unwrap_or_else(|| state.projection.clone());
        let previous_binding_digest = state.binding.manifest().binding_digest().clone();

        let bound = match bind(&projection, next_installation, admission) {
            BindResult::Bound(bound) => *bound,
            BindResult::Unrealized(report) => return Err(report),
        };

        let next_binding_digest = bound.binding.manifest().binding_digest().clone();
        let previous_controller = std::mem::replace(&mut state.controller, bound.controller);
        state.binding = Arc::new(bound.binding);
        state.projection = projection;
        let previous_revoked = previous_controller.revoke();

        Ok(RebindTransition {
            previous_binding_digest,
            next_binding_digest,
            previous_revoked,
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, SlotState<C, A>> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, SlotState<C, A>> {
        self.state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
