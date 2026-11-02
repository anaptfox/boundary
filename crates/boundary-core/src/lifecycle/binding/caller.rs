use std::{
    any::{Any, TypeId},
    error::Error,
    future::Future,
};

use serde_json::Value;
use thiserror::Error;

use super::{Binding, BoundInteraction, InvocationCertainty, InvocationResultKind};
use crate::{Interaction, WireCodec};

use super::super::installation::{
    DirectInputKind, InstallationCallFault, InstallationInput, InstallationOutcome,
    InstallationRequestFault, InteractionMode,
};
use crate::lifecycle::ProjectionHandle;

mod coordinated;
mod portable;

pub(crate) use portable::PortableInvocationOutcome;

/// Admission input borrowing the exact context and invocation.
pub struct AdmissionRequest<'a, Context: Sync + ?Sized> {
    context: &'a Context,
    interaction: &'a BoundInteraction,
    mode: InteractionMode,
    input: AdmissionInput<'a>,
    live: &'a (dyn Fn() -> bool + Send + Sync),
}

#[derive(Clone, Copy)]
enum AdmissionInput<'a> {
    Native(&'a (dyn Any + Send + Sync)),
    Portable(&'a Value),
}

impl<'a, Context: Sync + ?Sized> AdmissionRequest<'a, Context> {
    pub(super) fn rebind(&self, interaction: &'a BoundInteraction) -> Self {
        Self {
            context: self.context,
            interaction,
            mode: self.mode,
            input: self.input,
            live: self.live,
        }
    }

    pub(super) fn is_live(&self) -> bool {
        (self.live)()
    }
    /// Returns the exact context later passed to the installed realization.
    #[must_use]
    pub const fn context(&self) -> &'a Context {
        self.context
    }

    /// Returns the exact bound interaction identity.
    #[must_use]
    pub const fn interaction(&self) -> &'a BoundInteraction {
        self.interaction
    }

    /// Returns the requested execution mode.
    #[must_use]
    pub const fn mode(&self) -> InteractionMode {
        self.mode
    }

    /// Returns the exact native interaction for a direct invocation.
    ///
    /// Request-mode admission has no native interaction because it crosses the
    /// portable request seam.
    #[must_use]
    pub fn native_input<O>(&self) -> Option<&'a O>
    where
        O: Interaction,
    {
        match self.input {
            AdmissionInput::Native(input) => input.downcast_ref::<O>(),
            AdmissionInput::Portable(_) => None,
        }
    }

    /// Returns normalized portable input for a request invocation.
    ///
    /// Direct native admission has no portable input and does not cross a
    /// [`WireCodec`](crate::WireCodec).
    #[must_use]
    pub const fn portable_input(&self) -> Option<&'a Value> {
        match self.input {
            AdmissionInput::Native(_) => None,
            AdmissionInput::Portable(input) => Some(input),
        }
    }
}

/// Per-invocation admission decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionDecision {
    /// Permit this exact invocation.
    Admit,
    /// Deny without invoking the selected realization.
    Deny {
        /// Stable policy-owned denial code.
        code: String,
    },
}

/// Host admission seam evaluated for every call or request.
pub trait Admission<Context = ()>: Send + Sync + 'static
where
    Context: Sync + ?Sized,
{
    /// Evaluates one exact invocation.
    fn admit<'a>(
        &'a self,
        request: AdmissionRequest<'a, Context>,
    ) -> impl Future<Output = AdmissionDecision> + Send + 'a;
}

/// Explicit policy that admits every invocation.
#[derive(Clone, Copy, Debug, Default)]
pub struct AdmitAll;

impl<Context: Sync + ?Sized> Admission<Context> for AdmitAll {
    fn admit<'a>(
        &'a self,
        _request: AdmissionRequest<'a, Context>,
    ) -> impl Future<Output = AdmissionDecision> + Send + 'a {
        std::future::ready(AdmissionDecision::Admit)
    }
}

/// Constructs the explicit admit-all policy.
#[must_use]
pub const fn admit_all() -> AdmitAll {
    AdmitAll
}

/// Direct invocation failure preserving the exact declared Rust error.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CallerError<E: Error + 'static> {
    /// The interaction returned its exact declared domain error.
    #[error(transparent)]
    Declared(E),
    /// Host admission rejected the invocation.
    #[error("invocation denied: {code}")]
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// The binding or its pinned installation was revoked.
    #[error("binding is revoked")]
    Revoked,
    /// A selected dynamic realization could not accept portable input.
    #[error("dynamic interaction input is invalid")]
    InvalidInput,
    /// This handle did not select direct execution.
    #[error("direct mode is not selected by this handle")]
    ModeNotSelected,
    /// This handle belongs to another projection or exact contract.
    #[error("handle does not belong to this binding")]
    WrongProjection,
    /// The realization failed or returned invalid boundary data.
    #[error("interaction realization failed")]
    Unknown,
    /// The realization proved that the interaction effect did not start.
    #[error("interaction realization did not start")]
    NotStarted,
    /// The realization proved that the interaction effect did not complete.
    #[error("interaction realization did not complete")]
    NotCompleted,
}

impl<E: Error + 'static> CallerError<E> {
    /// Returns the portable effect certainty for this failure.
    #[must_use]
    pub const fn certainty(&self) -> InvocationCertainty {
        match self {
            Self::Declared(_) => InvocationCertainty::Completed,
            Self::Unknown => InvocationCertainty::Unknown,
            Self::NotCompleted => InvocationCertainty::NotCompleted,
            Self::NotStarted
            | Self::Denied { .. }
            | Self::Revoked
            | Self::InvalidInput
            | Self::ModeNotSelected
            | Self::WrongProjection => InvocationCertainty::NotStarted,
        }
    }

    /// Returns the stable portable result category for this failure.
    #[must_use]
    pub const fn result_kind(&self) -> InvocationResultKind {
        match self {
            Self::Declared(_) => InvocationResultKind::DeclaredError,
            Self::Denied { .. } => InvocationResultKind::Denied,
            Self::Revoked
            | Self::InvalidInput
            | Self::ModeNotSelected
            | Self::WrongProjection
            | Self::Unknown
            | Self::NotStarted
            | Self::NotCompleted => InvocationResultKind::Fault,
        }
    }
}

/// Request-creation failure with implementation details removed.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[non_exhaustive]
pub enum RequestError {
    /// Host admission or the request capability rejected the invocation.
    #[error("request denied: {code}")]
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// The binding or its pinned installation was revoked.
    #[error("binding is revoked")]
    Revoked,
    /// The interaction codec could not produce valid portable input.
    #[error("interaction input is invalid")]
    InvalidInput,
    /// This handle did not select request creation.
    #[error("request mode is not selected by this handle")]
    ModeNotSelected,
    /// This handle belongs to another projection or exact contract.
    #[error("handle does not belong to this binding")]
    WrongProjection,
    /// The request realization failed or returned invalid public data.
    #[error("request realization failed")]
    Unknown,
    /// Host coordination cannot establish whether a consequential effect completed.
    #[error("request coordination outcome is uncertain")]
    Uncertain,
}

impl RequestError {
    /// Returns the portable effect certainty for this request failure.
    #[must_use]
    pub const fn certainty(&self) -> InvocationCertainty {
        match self {
            Self::Uncertain => InvocationCertainty::Unknown,
            _ => InvocationCertainty::NotStarted,
        }
    }

    /// Returns the stable portable result category for this request failure.
    #[must_use]
    pub const fn result_kind(&self) -> InvocationResultKind {
        match self {
            Self::Denied { .. } => InvocationResultKind::Denied,
            Self::Revoked
            | Self::InvalidInput
            | Self::ModeNotSelected
            | Self::WrongProjection
            | Self::Unknown
            | Self::Uncertain => InvocationResultKind::Fault,
        }
    }
}

/// Stateless caller borrowed from one complete binding.
pub struct Caller<'a, Context: Sync + ?Sized, A> {
    pub(super) binding: &'a Binding<Context, A>,
}

impl<Context, A> Caller<'_, Context, A>
where
    Context: Sync + ?Sized + 'static,
    A: Admission<Context>,
{
    /// Executes a direct realization using context borrowed only for this call.
    ///
    /// # Errors
    ///
    /// Returns the exact declared interaction error or a stable lifecycle fault.
    pub async fn call<O>(
        &self,
        context: &Context,
        handle: &ProjectionHandle<O>,
        interaction: O,
    ) -> Result<O::Output, CallerError<O::Error>>
    where
        O: Interaction + Sync,
    {
        self.check_live().map_err(map_call_preflight)?;
        let bound = self
            .selected(handle, InteractionMode::Direct)
            .map_err(map_call_preflight)?;
        if !self.binding.coordinators.is_empty() {
            let input = O::InputCodec::encode(&interaction)
                .and_then(O::InputCodec::normalize)
                .map_err(|_| CallerError::InvalidInput)?;
            return self.call_coordinated::<O>(context, bound, input).await;
        }
        let realization = self
            .binding
            .installation
            .direct(bound.interaction_id(), bound.actual_contract_digest())
            .ok_or(CallerError::Unknown)?;
        let exact_contract = bound.expected_contract_digest() == bound.actual_contract_digest();
        let portable_input = match realization.input_kind() {
            DirectInputKind::Native(actual_type)
                if exact_contract && actual_type == TypeId::of::<O>() =>
            {
                None
            }
            DirectInputKind::Native(_) | DirectInputKind::Portable => Some(
                O::InputCodec::encode(&interaction)
                    .and_then(O::InputCodec::normalize)
                    .map_err(|_| CallerError::InvalidInput)?,
            ),
        };
        let admission_input = match portable_input.as_ref() {
            Some(input) => AdmissionInput::Portable(input),
            None => AdmissionInput::Native(&interaction),
        };
        let live = || !self.binding.is_revoked();
        match self
            .binding
            .admission
            .admit(AdmissionRequest {
                context,
                interaction: bound,
                mode: InteractionMode::Direct,
                input: admission_input,
                live: &live,
            })
            .await
        {
            AdmissionDecision::Admit => {}
            AdmissionDecision::Deny { code } => return Err(CallerError::Denied { code }),
        }
        self.check_live().map_err(map_call_preflight)?;
        let input = match portable_input {
            Some(input) => InstallationInput::Portable(input),
            None => InstallationInput::Native(Box::new(interaction)),
        };
        match realization.call(context, input).await {
            Ok(InstallationOutcome::Returned(value)) => value
                .downcast::<O::Output>()
                .map(|output| *output)
                .map_err(|_| CallerError::Unknown),
            Ok(InstallationOutcome::Declared(value)) => {
                let error = value
                    .downcast::<O::Error>()
                    .map_err(|_| CallerError::Unknown)?;
                Err(CallerError::Declared(*error))
            }
            Ok(InstallationOutcome::PortableReturned(value)) => {
                O::OutputCodec::decode(value).map_err(|_| CallerError::Unknown)
            }
            Ok(InstallationOutcome::PortableDeclared { code, details }) => {
                let error =
                    crate::codec::decode_declared::<O::Error, O::ErrorCodec>(&code, details)
                        .map_err(|_| CallerError::Unknown)?;
                Err(CallerError::Declared(error))
            }
            Ok(InstallationOutcome::Denied(code)) => Err(CallerError::Denied { code }),
            Err(InstallationCallFault::InvalidInput) => Err(CallerError::InvalidInput),
            Err(InstallationCallFault::NotStarted) => Err(CallerError::NotStarted),
            Err(InstallationCallFault::NotCompleted) => Err(CallerError::NotCompleted),
            Err(InstallationCallFault::InvalidOutcome | InstallationCallFault::Unknown) => {
                Err(CallerError::Unknown)
            }
        }
    }

    /// Creates a request using context borrowed only for this invocation.
    ///
    /// # Errors
    ///
    /// Returns a stable admission, lifecycle, or request capability fault.
    pub async fn request<O>(
        &self,
        context: &Context,
        handle: &ProjectionHandle<O>,
        interaction: O,
    ) -> Result<Value, RequestError>
    where
        O: Interaction,
    {
        self.check_live().map_err(map_request_preflight)?;
        let bound = self
            .selected(handle, InteractionMode::Request)
            .map_err(map_request_preflight)?;
        let input = O::InputCodec::encode(&interaction)
            .and_then(O::InputCodec::normalize)
            .map_err(|_| RequestError::InvalidInput)?;
        if !self.binding.coordinators.is_empty() {
            return self.request_coordinated(context, bound, input).await;
        }
        let live = || !self.binding.is_revoked();
        match self
            .binding
            .admission
            .admit(AdmissionRequest {
                context,
                interaction: bound,
                mode: InteractionMode::Request,
                input: AdmissionInput::Portable(&input),
                live: &live,
            })
            .await
        {
            AdmissionDecision::Admit => {}
            AdmissionDecision::Deny { code } => return Err(RequestError::Denied { code }),
        }
        self.check_live().map_err(map_request_preflight)?;
        let realization = self
            .binding
            .installation
            .request(bound.interaction_id(), bound.actual_contract_digest())
            .ok_or(RequestError::Unknown)?;
        match realization.request(context, input).await {
            Ok(proposal) => Ok(proposal),
            Err(InstallationRequestFault::InvalidInput) => Err(RequestError::InvalidInput),
            Err(InstallationRequestFault::Denied(code)) => Err(RequestError::Denied { code }),
            Err(InstallationRequestFault::Unknown) => Err(RequestError::Unknown),
        }
    }

    fn check_live(&self) -> Result<(), PreflightFault> {
        if self.binding.is_revoked() {
            Err(PreflightFault::Revoked)
        } else {
            Ok(())
        }
    }

    fn selected<O>(
        &self,
        handle: &ProjectionHandle<O>,
        mode: InteractionMode,
    ) -> Result<&BoundInteraction, PreflightFault>
    where
        O: Interaction,
    {
        if handle.projection_digest() != self.binding.manifest.projection_digest() {
            return Err(PreflightFault::WrongProjection);
        }
        if !handle.modes().contains(mode) {
            return Err(PreflightFault::ModeNotSelected);
        }
        let bound = self
            .binding
            .manifest
            .interaction(handle.alias(), mode)
            .ok_or(PreflightFault::WrongProjection)?;
        if bound.interaction_id() != handle.interaction_id()
            || bound.expected_contract_digest() != handle.contract_digest()
            || bound.input_arity() != handle.input_arity()
        {
            return Err(PreflightFault::WrongProjection);
        }
        Ok(bound)
    }
}

#[derive(Clone, Copy)]
enum PreflightFault {
    Revoked,
    ModeNotSelected,
    WrongProjection,
}

fn map_call_preflight<E: Error + 'static>(fault: PreflightFault) -> CallerError<E> {
    match fault {
        PreflightFault::Revoked => CallerError::Revoked,
        PreflightFault::ModeNotSelected => CallerError::ModeNotSelected,
        PreflightFault::WrongProjection => CallerError::WrongProjection,
    }
}

fn map_request_preflight(fault: PreflightFault) -> RequestError {
    match fault {
        PreflightFault::Revoked => RequestError::Revoked,
        PreflightFault::ModeNotSelected => RequestError::ModeNotSelected,
        PreflightFault::WrongProjection => RequestError::WrongProjection,
    }
}
