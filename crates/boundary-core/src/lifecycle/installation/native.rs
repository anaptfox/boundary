use super::adapter::{
    ContributionKind, DirectInputKind, DynamicDirect, DynamicRequest, InstallationCallFault,
    InstallationContribution, InstallationInput, InstallationOutcome, InstallationRequestFault,
};
use super::{RealizationId, RequestIdentity};
use crate::InteractionDescriptor;
use crate::lifecycle::NativeInteraction;
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

/// Outcome supplied by a host-native portable dispatcher.
#[derive(Debug)]
pub enum NativeValueOutcome {
    /// Direct execution result.
    Returned(Value),
    /// Declared direct error.
    Declared {
        /// Stable host-owned error code.
        code: String,
        /// Portable declared error details.
        details: Value,
    },
    /// Proposal only; no direct execution.
    Proposed(Value),
    /// Explicit host denial.
    Denied(String),
}

/// The host could not establish the dispatch result.
#[derive(Clone, Copy, Debug)]
pub struct NativeValueFault;

/// Synchronous portable dispatcher; the caller controls all native context.
pub trait NativeValueDispatcher<C: Sync + ?Sized>: Send + Sync + 'static {
    /// Dispatch once; failure means the result is not established.
    ///
    /// # Errors
    /// Returns a sanitized fault when the host cannot establish the result.
    fn dispatch(
        &self,
        context: &C,
        interaction: &InteractionDescriptor,
        input: &Value,
    ) -> Result<NativeValueOutcome, NativeValueFault>;
}

struct Adapter<C: Sync + ?Sized, D> {
    interaction: NativeInteraction,
    dispatcher: Arc<D>,
    marker: std::marker::PhantomData<fn(&C)>,
}
impl<C: Sync + ?Sized + 'static, D: NativeValueDispatcher<C>> DynamicDirect<C> for Adapter<C, D> {
    fn input_kind(&self) -> DirectInputKind {
        DirectInputKind::Portable
    }
    fn call<'a>(
        &'a self,
        context: &'a C,
        input: InstallationInput,
    ) -> Pin<Box<dyn Future<Output = Result<InstallationOutcome, InstallationCallFault>> + Send + 'a>>
    {
        Box::pin(async move {
            let InstallationInput::Portable(value) = input else {
                return Err(InstallationCallFault::InvalidInput);
            };
            if !self
                .interaction
                .descriptor()
                .contract()
                .input_schema()
                .accepts(&value)
            {
                return Err(InstallationCallFault::InvalidInput);
            }
            match self
                .dispatcher
                .dispatch(context, self.interaction.descriptor(), &value)
                .map_err(|_| InstallationCallFault::Unknown)?
            {
                NativeValueOutcome::Returned(value) => {
                    Ok(InstallationOutcome::PortableReturned(value))
                }
                NativeValueOutcome::Declared { code, details } => {
                    Ok(InstallationOutcome::PortableDeclared { code, details })
                }
                NativeValueOutcome::Denied(code) => Ok(InstallationOutcome::Denied(code)),
                NativeValueOutcome::Proposed(_) => Err(InstallationCallFault::InvalidOutcome),
            }
        })
    }
}
impl<C: Sync + ?Sized + 'static, D: NativeValueDispatcher<C>> DynamicRequest<C> for Adapter<C, D> {
    fn request<'a>(
        &'a self,
        context: &'a C,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, InstallationRequestFault>> + Send + 'a>> {
        Box::pin(async move {
            if !self
                .interaction
                .descriptor()
                .contract()
                .input_schema()
                .accepts(&input)
            {
                return Err(InstallationRequestFault::InvalidInput);
            }
            match self
                .dispatcher
                .dispatch(context, self.interaction.descriptor(), &input)
                .map_err(|_| InstallationRequestFault::Unknown)?
            {
                NativeValueOutcome::Proposed(value) => Ok(value),
                NativeValueOutcome::Denied(code) => Err(InstallationRequestFault::Denied(code)),
                _ => Err(InstallationRequestFault::Unknown),
            }
        })
    }
}
/// Contributes direct execution backed by a portable native dispatcher.
#[must_use]
pub fn native_direct_realization<C: Sync + ?Sized + 'static, D: NativeValueDispatcher<C>>(
    interaction: &NativeInteraction,
    id: RealizationId,
    dispatcher: Arc<D>,
) -> InstallationContribution<C> {
    InstallationContribution {
        interaction: interaction.erased.clone(),
        realization_id: Some(id),
        kind: ContributionKind::Direct(Arc::new(Adapter {
            interaction: interaction.clone(),
            dispatcher,
            marker: std::marker::PhantomData,
        })),
    }
}
/// Contributes a request proposal capability with its exact control identity.
#[must_use]
pub fn native_request_realization<C: Sync + ?Sized + 'static, D: NativeValueDispatcher<C>>(
    interaction: &NativeInteraction,
    id: RealizationId,
    identity: RequestIdentity,
    dispatcher: Arc<D>,
) -> InstallationContribution<C> {
    InstallationContribution {
        interaction: interaction.erased.clone(),
        realization_id: Some(id),
        kind: ContributionKind::Request {
            capability: Arc::new(Adapter {
                interaction: interaction.clone(),
                dispatcher,
                marker: std::marker::PhantomData,
            }),
            identity: Some(Box::new(identity)),
        },
    }
}

/// Retains an unrealized native declaration in the installation.
#[must_use]
pub fn native_declared_interaction<C: Sync + ?Sized>(
    interaction: &NativeInteraction,
) -> InstallationContribution<C> {
    InstallationContribution {
        interaction: interaction.erased.clone(),
        realization_id: None,
        kind: ContributionKind::Declared,
    }
}
