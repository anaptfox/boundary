use std::{
    any::{Any, TypeId},
    future::Future,
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
};

use serde_json::Value;
use thiserror::Error;

use super::super::{CompiledInteraction, ErasedInteraction, RealizationId};
use super::RequestIdentity;
use crate::{
    DeclaredErrorCodec, Handler, Interaction, InteractionDescriptor, PortableFault, WireCodec,
    canonical_json,
};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Public failure returned by a request realization.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[non_exhaustive]
pub enum RequestCapabilityFault {
    /// Host policy rejected the request.
    #[error("request denied: {code}")]
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// Request creation failed without exposing implementation details.
    #[error("request capability unavailable")]
    Unavailable,
}

/// A typed capability that creates a request without applying the interaction.
pub trait RequestCapability<O, Context = ()>: Send + Sync + 'static
where
    O: Interaction,
    Context: Sync + ?Sized,
{
    /// Creates portable public request data.
    fn request<'a>(
        &'a self,
        context: &'a Context,
        interaction: O,
    ) -> impl Future<Output = Result<Value, RequestCapabilityFault>> + Send + 'a;
}

/// One native-dispatch invocation with its exact compiled contract.
pub struct NativeDispatchRequest<'a, Context: Sync + ?Sized> {
    context: &'a Context,
    interaction: &'a InteractionDescriptor,
    input: &'a Value,
}

impl<'a, Context: Sync + ?Sized> NativeDispatchRequest<'a, Context> {
    /// Returns the exact context borrowed for this invocation.
    #[must_use]
    pub const fn context(&self) -> &'a Context {
        self.context
    }

    /// Returns the exact compiled interaction descriptor.
    #[must_use]
    pub const fn interaction(&self) -> &'a InteractionDescriptor {
        self.interaction
    }

    /// Returns normalized portable input.
    #[must_use]
    pub const fn input(&self) -> &'a Value {
        self.input
    }
}

/// Portable result produced by a host-native dispatcher.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeDispatchOutcome {
    /// Successful declared output.
    Returned(Value),
    /// Exact declared interaction error.
    Declared(Value),
    /// Host policy denied before the interaction effect began.
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
}

/// Sanitized failure produced by a host-native dispatcher.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[non_exhaustive]
pub enum NativeDispatchFault {
    /// The dispatcher proved that the interaction effect did not start.
    #[error("native dispatcher did not start the interaction")]
    NotStarted,
    /// The dispatcher proved that the interaction started but did not complete.
    #[error("native dispatcher did not complete the interaction")]
    NotCompleted,
    /// The interaction may have started and completion cannot be proved.
    #[error("native dispatcher outcome is unknown")]
    Unknown,
}

/// Existing-host seam for routing exact interactions through a native dispatcher.
pub trait NativeDispatcher<Context = ()>: Send + Sync + 'static
where
    Context: Sync + ?Sized,
{
    /// Dispatches one normalized invocation.
    fn dispatch<'a>(
        &'a self,
        request: NativeDispatchRequest<'a, Context>,
    ) -> impl Future<Output = Result<NativeDispatchOutcome, NativeDispatchFault>> + Send + 'a;
}

pub(in crate::lifecycle) enum InstallationOutcome {
    Returned(Box<dyn Any + Send>),
    Declared(Box<dyn Any + Send>),
    PortableReturned(Value),
    PortableDeclared { code: String, details: Value },
    Denied(String),
}

#[derive(Clone, Copy)]
pub(in crate::lifecycle) enum DirectInputKind {
    Native(TypeId),
    Portable,
}

pub(in crate::lifecycle) enum InstallationInput {
    Native(Box<dyn Any + Send>),
    Portable(Value),
}

#[derive(Clone, Copy)]
pub(in crate::lifecycle) enum InstallationCallFault {
    InvalidInput,
    InvalidOutcome,
    NotStarted,
    NotCompleted,
    Unknown,
}

pub(in crate::lifecycle) trait DynamicDirect<C: Sync + ?Sized>:
    Send + Sync
{
    fn input_kind(&self) -> DirectInputKind;

    fn clear_retained(&self) {}

    fn call<'a>(
        &'a self,
        context: &'a C,
        input: InstallationInput,
    ) -> BoxFuture<'a, Result<InstallationOutcome, InstallationCallFault>>;
}

pub(in crate::lifecycle) trait DynamicRequest<C: Sync + ?Sized>:
    Send + Sync
{
    fn request<'a>(
        &'a self,
        context: &'a C,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, InstallationRequestFault>>;
}

pub(in crate::lifecycle) enum InstallationRequestFault {
    InvalidInput,
    Denied(String),
    Unknown,
}

struct BoundDirect<O, C: Sync + ?Sized, H> {
    handler: H,
    _marker: PhantomData<fn(O, &C)>,
}

impl<O, C, H> DynamicDirect<C> for BoundDirect<O, C, H>
where
    O: Interaction,
    C: Sync + ?Sized,
    H: Handler<O, C>,
{
    fn input_kind(&self) -> DirectInputKind {
        DirectInputKind::Native(TypeId::of::<O>())
    }

    fn call<'a>(
        &'a self,
        context: &'a C,
        input: InstallationInput,
    ) -> BoxFuture<'a, Result<InstallationOutcome, InstallationCallFault>> {
        Box::pin(async move {
            let (interaction, portable) = match input {
                InstallationInput::Native(interaction) => (
                    interaction
                        .downcast::<O>()
                        .map_err(|_| InstallationCallFault::InvalidInput)?,
                    false,
                ),
                InstallationInput::Portable(value) => (
                    Box::new(
                        O::InputCodec::decode(value)
                            .map_err(|_| InstallationCallFault::InvalidInput)?,
                    ),
                    true,
                ),
            };
            match self.handler.handle(context, *interaction).await {
                Ok(output) if portable => O::OutputCodec::encode(&output)
                    .and_then(O::OutputCodec::normalize)
                    .map(InstallationOutcome::PortableReturned)
                    .map_err(|_| InstallationCallFault::InvalidOutcome),
                Ok(output) => Ok(InstallationOutcome::Returned(Box::new(output))),
                Err(error) if portable => {
                    let code = error.code().to_owned();
                    O::ErrorCodec::encode(&error)
                        .and_then(|details| {
                            crate::codec::normalize_declared::<O::Error, O::ErrorCodec>(
                                &code, details,
                            )
                        })
                        .map(|details| InstallationOutcome::PortableDeclared { code, details })
                        .map_err(|_| InstallationCallFault::InvalidOutcome)
                }
                Err(error) => Ok(InstallationOutcome::Declared(Box::new(error))),
            }
        })
    }
}

struct BoundRequest<O, C: Sync + ?Sized, H> {
    handler: H,
    _marker: PhantomData<fn(O, &C)>,
}

impl<O, C, H> DynamicRequest<C> for BoundRequest<O, C, H>
where
    O: Interaction,
    C: Sync + ?Sized,
    H: RequestCapability<O, C>,
{
    fn request<'a>(
        &'a self,
        context: &'a C,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, InstallationRequestFault>> {
        Box::pin(async move {
            let interaction =
                O::InputCodec::decode(input).map_err(|_| InstallationRequestFault::InvalidInput)?;
            let proposal = self
                .handler
                .request(context, interaction)
                .await
                .map_err(|error| match error {
                    RequestCapabilityFault::Denied { code } => {
                        InstallationRequestFault::Denied(code)
                    }
                    RequestCapabilityFault::Unavailable => InstallationRequestFault::Unknown,
                })?;
            canonical_json(&proposal).map_err(|_| InstallationRequestFault::Unknown)?;
            Ok(proposal)
        })
    }
}

struct BoundDispatcher<O, C: Sync + ?Sized, D> {
    interaction: InteractionDescriptor,
    dispatcher: Arc<D>,
    _marker: PhantomData<fn(O, &C)>,
}

impl<O, C, D> DynamicDirect<C> for BoundDispatcher<O, C, D>
where
    O: Interaction,
    C: Sync + ?Sized,
    D: NativeDispatcher<C>,
{
    fn input_kind(&self) -> DirectInputKind {
        DirectInputKind::Portable
    }

    fn call<'a>(
        &'a self,
        context: &'a C,
        input: InstallationInput,
    ) -> BoxFuture<'a, Result<InstallationOutcome, InstallationCallFault>> {
        Box::pin(async move {
            let InstallationInput::Portable(input) = input else {
                return Err(InstallationCallFault::InvalidInput);
            };
            let input =
                O::InputCodec::normalize(input).map_err(|_| InstallationCallFault::InvalidInput)?;
            let outcome = self
                .dispatcher
                .dispatch(NativeDispatchRequest {
                    context,
                    interaction: &self.interaction,
                    input: &input,
                })
                .await
                .map_err(|fault| match fault {
                    NativeDispatchFault::NotStarted => InstallationCallFault::NotStarted,
                    NativeDispatchFault::NotCompleted => InstallationCallFault::NotCompleted,
                    NativeDispatchFault::Unknown => InstallationCallFault::Unknown,
                })?;
            match outcome {
                NativeDispatchOutcome::Returned(value) => {
                    let output = O::OutputCodec::decode(value)
                        .map_err(|_| InstallationCallFault::InvalidOutcome)?;
                    let output = O::OutputCodec::encode(&output)
                        .and_then(O::OutputCodec::normalize)
                        .map_err(|_| InstallationCallFault::InvalidOutcome)?;
                    Ok(InstallationOutcome::PortableReturned(output))
                }
                NativeDispatchOutcome::Declared(value) => {
                    let error = O::ErrorCodec::decode(value)
                        .map_err(|_| InstallationCallFault::InvalidOutcome)?;
                    let code = error.code().to_owned();
                    let details = O::ErrorCodec::encode(&error)
                        .and_then(|details| {
                            crate::codec::normalize_declared::<O::Error, O::ErrorCodec>(
                                &code, details,
                            )
                        })
                        .map_err(|_| InstallationCallFault::InvalidOutcome)?;
                    Ok(InstallationOutcome::PortableDeclared { code, details })
                }
                NativeDispatchOutcome::Denied { code } => Ok(InstallationOutcome::Denied(code)),
            }
        })
    }
}

pub(super) enum ContributionKind<C: Sync + ?Sized> {
    Declared,
    Direct(Arc<dyn DynamicDirect<C>>),
    Request {
        capability: Arc<dyn DynamicRequest<C>>,
        identity: Option<Box<RequestIdentity>>,
    },
}

/// One exact, immutable contribution used to assemble an installation.
pub struct InstallationContribution<C: Sync + ?Sized = ()> {
    pub(super) interaction: ErasedInteraction,
    pub(super) realization_id: Option<RealizationId>,
    pub(super) kind: ContributionKind<C>,
}

/// Retains one declared interaction even when no execution mode is realized.
///
/// Binding can therefore distinguish a known interaction with a missing mode
/// from an interaction that was never installed.
#[must_use]
pub fn declared_interaction<O, C>(
    interaction: &CompiledInteraction<O>,
) -> InstallationContribution<C>
where
    O: Interaction,
    C: Sync + ?Sized + 'static,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: None,
        kind: ContributionKind::Declared,
    }
}

/// Adapts one typed direct handler to an installation contribution.
#[must_use]
pub fn direct_realization<O, C, H>(
    interaction: &CompiledInteraction<O>,
    realization_id: RealizationId,
    handler: H,
) -> InstallationContribution<C>
where
    O: Interaction,
    C: Sync + ?Sized + 'static,
    H: Handler<O, C>,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: Some(realization_id),
        kind: ContributionKind::Direct(Arc::new(BoundDirect::<O, C, H> {
            handler,
            _marker: PhantomData,
        })),
    }
}

/// Adapts one typed request capability to an installation contribution.
#[must_use]
pub fn request_realization<O, C, H>(
    interaction: &CompiledInteraction<O>,
    realization_id: RealizationId,
    handler: H,
) -> InstallationContribution<C>
where
    O: Interaction,
    C: Sync + ?Sized + 'static,
    H: RequestCapability<O, C>,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: Some(realization_id),
        kind: ContributionKind::Request {
            capability: Arc::new(BoundRequest::<O, C, H> {
                handler,
                _marker: PhantomData,
            }),
            identity: None,
        },
    }
}

/// Adapts one typed request capability with its exact portable control identity.
#[must_use]
pub fn identified_request_realization<O, C, H>(
    interaction: &CompiledInteraction<O>,
    realization_id: RealizationId,
    identity: RequestIdentity,
    handler: H,
) -> InstallationContribution<C>
where
    O: Interaction,
    C: Sync + ?Sized + 'static,
    H: RequestCapability<O, C>,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: Some(realization_id),
        kind: ContributionKind::Request {
            capability: Arc::new(BoundRequest::<O, C, H> {
                handler,
                _marker: PhantomData,
            }),
            identity: Some(Box::new(identity)),
        },
    }
}

/// Adapts one exact interaction to an existing host-native dispatcher.
#[must_use]
pub fn dispatch_realization<O, C, D>(
    interaction: &CompiledInteraction<O>,
    realization_id: RealizationId,
    dispatcher: Arc<D>,
) -> InstallationContribution<C>
where
    O: Interaction,
    C: Sync + ?Sized + 'static,
    D: NativeDispatcher<C>,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: Some(realization_id),
        kind: ContributionKind::Direct(Arc::new(BoundDispatcher::<O, C, D> {
            interaction: interaction.descriptor().clone(),
            dispatcher,
            _marker: PhantomData,
        })),
    }
}
