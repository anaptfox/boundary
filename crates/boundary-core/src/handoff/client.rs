use std::{error::Error, future::Future};

use serde_json::Value;
use thiserror::Error;

use super::protocol::{
    HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffResult, validate_outcome,
    validate_response,
};
use crate::lifecycle::{
    BindingManifest, BoundInteraction, InteractionMode, InvocationCertainty, ProjectionHandle,
    ProjectionModes,
};
use crate::{Interaction, WireCodec};

/// Sanitized transport failure. Native messages, stacks, and fields never cross.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("Handoff transport failed")]
pub struct TransportFault;

/// Transport-neutral boundary used by a remote caller.
pub trait HandoffTransport: Send + Sync {
    /// Sends one exact invocation and returns one untrusted version 1 outcome.
    fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> impl Future<Output = Result<HandoffOutcome, TransportFault>> + Send + '_;
}

/// Typed direct-call failure at a remote Handoff boundary.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum RemoteCallError<E: Error + 'static> {
    /// The interaction returned its exact declared domain error.
    #[error(transparent)]
    Declared(E),
    /// Admission denied before execution.
    #[error("invocation denied: {code}")]
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// Local input could not be encoded for the portable boundary.
    #[error("interaction input is invalid")]
    InvalidInput,
    /// The typed handle does not belong to this remote Binding.
    #[error("handle does not belong to this remote Binding")]
    WrongBinding,
    /// The remote returned a valid fault with explicit certainty.
    #[error("remote interaction failed: {cause:?}")]
    Fault {
        /// Stable sanitized remote cause.
        cause: HandoffFaultCause,
        /// Remote claim about effect completion.
        certainty: InvocationCertainty,
    },
    /// The remote outcome violated identity, schema, or certainty laws.
    #[error("remote outcome is invalid")]
    InvalidOutcome,
    /// The transport failed without proving whether execution completed.
    #[error(transparent)]
    Transport(TransportFault),
}

impl<E: Error + 'static> RemoteCallError<E> {
    /// Returns what this failure safely proves about execution.
    #[must_use]
    pub const fn certainty(&self) -> InvocationCertainty {
        match self {
            Self::Declared(_) => InvocationCertainty::Completed,
            Self::Denied { .. } | Self::InvalidInput | Self::WrongBinding => {
                InvocationCertainty::NotStarted
            }
            Self::Fault { certainty, .. } => *certainty,
            Self::InvalidOutcome | Self::Transport(_) => InvocationCertainty::Unknown,
        }
    }
}

/// Request-mode failure at a remote Handoff boundary.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[non_exhaustive]
pub enum RemoteRequestError {
    /// Admission or request policy denied before the interaction began.
    #[error("request denied: {code}")]
    Denied {
        /// Stable host-owned denial code.
        code: String,
    },
    /// Local input could not be encoded for the portable boundary.
    #[error("interaction input is invalid")]
    InvalidInput,
    /// The typed handle does not belong to this remote Binding.
    #[error("handle does not belong to this remote Binding")]
    WrongBinding,
    /// The remote returned a valid request fault.
    #[error("remote request failed: {cause:?}")]
    Fault {
        /// Stable sanitized request failure cause.
        cause: HandoffFaultCause,
        /// Remote claim about request-creation completion.
        certainty: InvocationCertainty,
    },
    /// The remote outcome violated identity, schema, or certainty laws.
    #[error("remote outcome is invalid")]
    InvalidOutcome,
    /// The transport failed without proving whether request creation completed.
    #[error(transparent)]
    Transport(TransportFault),
}

impl RemoteRequestError {
    /// Returns what this failure safely proves about the target interaction.
    #[must_use]
    pub const fn certainty(&self) -> InvocationCertainty {
        match self {
            Self::InvalidOutcome | Self::Transport(_) => InvocationCertainty::Unknown,
            Self::Denied { .. } | Self::InvalidInput | Self::WrongBinding => {
                InvocationCertainty::NotStarted
            }
            Self::Fault { certainty, .. } => *certainty,
        }
    }
}

/// Stateless typed client pinned to one exact remote Binding manifest.
pub struct RemoteCaller<T> {
    manifest: BindingManifest,
    transport: T,
}

impl<T> RemoteCaller<T> {
    /// Pins a validated Binding manifest and transport.
    #[must_use]
    pub const fn new(manifest: BindingManifest, transport: T) -> Self {
        Self {
            manifest,
            transport,
        }
    }

    /// Returns the exact pinned remote handshake.
    #[must_use]
    pub const fn manifest(&self) -> &BindingManifest {
        &self.manifest
    }

    /// Returns the underlying transport.
    #[must_use]
    pub const fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: HandoffTransport> RemoteCaller<T> {
    /// Executes one typed direct call through the pinned remote Binding.
    ///
    /// # Errors
    ///
    /// Returns an exact declared error or a sanitized boundary failure.
    pub async fn call<O>(
        &self,
        handle: &ProjectionHandle<O>,
        interaction: O,
    ) -> Result<O::Output, RemoteCallError<O::Error>>
    where
        O: Interaction,
    {
        let bound = self
            .selected(handle, InteractionMode::Direct)
            .ok_or(RemoteCallError::WrongBinding)?;
        let input = O::InputCodec::encode(&interaction)
            .and_then(O::InputCodec::normalize)
            .map_err(|_| RemoteCallError::InvalidInput)?;
        let invocation = HandoffInvocation::from_interaction(&self.manifest, bound, input);
        let outcome = self
            .transport
            .invoke(invocation.clone())
            .await
            .map_err(RemoteCallError::Transport)?;
        validate_response(&invocation, &outcome)
            .and_then(|()| validate_outcome(&self.manifest, &outcome))
            .map_err(|_| RemoteCallError::InvalidOutcome)?;
        let certainty = outcome.certainty();
        match outcome.into_result() {
            HandoffResult::Returned { value } => {
                O::OutputCodec::decode(value).map_err(|_| RemoteCallError::InvalidOutcome)
            }
            HandoffResult::DeclaredError { code, details } => {
                let error =
                    crate::codec::decode_declared::<O::Error, O::ErrorCodec>(&code, details)
                        .map_err(|_| RemoteCallError::InvalidOutcome)?;
                Err(RemoteCallError::Declared(error))
            }
            HandoffResult::Denied { code } => Err(RemoteCallError::Denied { code }),
            HandoffResult::Fault { cause, issues: _ } => {
                Err(RemoteCallError::Fault { cause, certainty })
            }
            HandoffResult::Proposed { .. } => Err(RemoteCallError::InvalidOutcome),
        }
    }

    /// Creates one public request without applying the target interaction.
    ///
    /// # Errors
    ///
    /// Returns a sanitized request or transport failure.
    pub async fn request<O>(
        &self,
        handle: &ProjectionHandle<O>,
        interaction: O,
    ) -> Result<Value, RemoteRequestError>
    where
        O: Interaction,
    {
        let bound = self
            .selected(handle, InteractionMode::Request)
            .ok_or(RemoteRequestError::WrongBinding)?;
        let input = O::InputCodec::encode(&interaction)
            .and_then(O::InputCodec::normalize)
            .map_err(|_| RemoteRequestError::InvalidInput)?;
        let invocation = HandoffInvocation::from_interaction(&self.manifest, bound, input);
        let outcome = self
            .transport
            .invoke(invocation.clone())
            .await
            .map_err(RemoteRequestError::Transport)?;
        validate_response(&invocation, &outcome)
            .and_then(|()| validate_outcome(&self.manifest, &outcome))
            .map_err(|_| RemoteRequestError::InvalidOutcome)?;
        let certainty = outcome.certainty();
        match outcome.into_result() {
            HandoffResult::Proposed { proposal } => Ok(proposal),
            HandoffResult::Denied { code } => Err(RemoteRequestError::Denied { code }),
            HandoffResult::Fault { cause, issues: _ } => {
                Err(RemoteRequestError::Fault { cause, certainty })
            }
            HandoffResult::Returned { .. } | HandoffResult::DeclaredError { .. } => {
                Err(RemoteRequestError::InvalidOutcome)
            }
        }
    }

    fn selected<O>(
        &self,
        handle: &ProjectionHandle<O>,
        mode: InteractionMode,
    ) -> Option<&BoundInteraction>
    where
        O: Interaction,
    {
        if handle.projection_digest() != self.manifest.projection_digest()
            || !mode_selected(handle.modes(), mode)
        {
            return None;
        }
        let bound = self.manifest.interaction(handle.alias(), mode)?;
        (bound.interaction_id() == handle.interaction_id()
            && bound.expected_contract_digest() == handle.contract_digest()
            && bound.input_arity() == handle.input_arity())
        .then_some(bound)
    }
}

fn mode_selected(modes: ProjectionModes, mode: InteractionMode) -> bool {
    matches!(
        (modes, mode),
        (ProjectionModes::Direct, InteractionMode::Direct)
            | (ProjectionModes::Request, InteractionMode::Request)
            | (ProjectionModes::DirectAndRequest, _)
    )
}
