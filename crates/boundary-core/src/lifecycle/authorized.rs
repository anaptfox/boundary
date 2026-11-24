//! Per-invocation authorization that narrows caller context for realizations.

use std::{error::Error, future::Future, pin::Pin, sync::Arc};

use serde_json::Value;

use super::{
    AdmitAll, BindResult, Binding, BindingController, BindingManifest, BoundInteraction,
    CallerError, Installation, InteractionMode, Projection, ProjectionHandle, RequestError,
    UnrealizedReport, admit_all, bind,
};
use crate::{Interaction, WireCodec};

/// Result of authorizing one invocation and deriving its realization context.
pub enum AuthorizationDecision<Auth> {
    /// Permit the invocation with the typed context passed to its realization.
    Allow(Auth),
    /// Reject the invocation without calling its realization.
    Deny {
        /// Stable host-owned denial code.
        code: String,
    },
}

/// Borrowed details supplied to a host authorization policy.
pub struct AuthorizationRequest<'a, CallerContext: Sync + ?Sized> {
    context: &'a CallerContext,
    interaction: &'a BoundInteraction,
    mode: InteractionMode,
    native_input: Option<&'a (dyn std::any::Any + Send + Sync)>,
    portable_input: Option<&'a Value>,
    live: &'a (dyn Fn() -> bool + Send + Sync),
}

impl<'a, CallerContext: Sync + ?Sized> AuthorizationRequest<'a, CallerContext> {
    fn direct<O: Interaction + Sync>(
        context: &'a CallerContext,
        interaction: &'a BoundInteraction,
        input: &'a O,
        live: &'a (dyn Fn() -> bool + Send + Sync),
    ) -> Self {
        Self {
            context,
            interaction,
            mode: InteractionMode::Direct,
            native_input: Some(input),
            portable_input: None,
            live,
        }
    }

    fn request(
        context: &'a CallerContext,
        interaction: &'a BoundInteraction,
        input: &'a Value,
        live: &'a (dyn Fn() -> bool + Send + Sync),
    ) -> Self {
        Self {
            context,
            interaction,
            mode: InteractionMode::Request,
            native_input: None,
            portable_input: Some(input),
            live,
        }
    }

    /// Returns the raw caller context supplied for this invocation.
    #[must_use]
    pub const fn context(&self) -> &'a CallerContext {
        self.context
    }

    /// Returns the exact selected interaction identity.
    #[must_use]
    pub const fn interaction(&self) -> &'a BoundInteraction {
        self.interaction
    }

    /// Returns whether this authorization is for direct execution or a request.
    #[must_use]
    pub const fn mode(&self) -> InteractionMode {
        self.mode
    }

    /// Returns the typed native input for direct execution, if present.
    #[must_use]
    pub fn native_input<O: Interaction>(&self) -> Option<&'a O> {
        self.native_input
            .and_then(|input| input.downcast_ref::<O>())
    }

    /// Returns normalized portable input for request creation, if present.
    #[must_use]
    pub const fn portable_input(&self) -> Option<&'a Value> {
        self.portable_input
    }

    /// Returns whether the binding remains live.
    #[must_use]
    pub fn is_live(&self) -> bool {
        (self.live)()
    }
}

/// Host policy that derives the typed context used by an installed realization.
pub trait Authorizer<CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static>:
    Send + Sync + 'static
{
    /// Authorizes the invocation and, when allowed, returns its realization context.
    fn authorize<'a>(
        &'a self,
        request: AuthorizationRequest<'a, CallerContext>,
    ) -> impl Future<Output = AuthorizationDecision<Auth>> + Send + 'a;
}

/// Closure-backed [`Authorizer`] accepting a boxed borrowing future.
pub struct AuthorizerFn<F>(F);

impl<F> AuthorizerFn<F> {
    /// Wraps a closure as an authorizer.
    #[must_use]
    pub const fn new(authorizer: F) -> Self {
        Self(authorizer)
    }
}

impl<CallerContext, Auth, F> Authorizer<CallerContext, Auth> for AuthorizerFn<F>
where
    CallerContext: Sync + ?Sized,
    Auth: Send + Sync + 'static,
    F: for<'a> Fn(
            AuthorizationRequest<'a, CallerContext>,
        )
            -> Pin<Box<dyn Future<Output = AuthorizationDecision<Auth>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    fn authorize<'a>(
        &'a self,
        request: AuthorizationRequest<'a, CallerContext>,
    ) -> impl Future<Output = AuthorizationDecision<Auth>> + Send + 'a {
        (self.0)(request)
    }
}

/// Wraps a closure as an [`Authorizer`].
#[must_use]
pub const fn authorize_fn<F>(authorizer: F) -> AuthorizerFn<F> {
    AuthorizerFn::new(authorizer)
}

/// A live authorized view over an atomically bound installation.
pub struct AuthorizedBinding<CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static, Z> {
    inner: Binding<Auth, AdmitAll>,
    authorizer: Arc<Z>,
    controller: Arc<BindingController>,
    _caller_context: std::marker::PhantomData<fn(&CallerContext)>,
}

impl<CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static, Z>
    AuthorizedBinding<CallerContext, Auth, Z>
{
    /// Returns the immutable exact binding manifest.
    #[must_use]
    pub fn manifest(&self) -> &BindingManifest {
        self.inner.manifest()
    }

    /// Borrows the authorized caller capability.
    #[must_use]
    pub fn caller(&self) -> AuthorizedCaller<'_, CallerContext, Auth, Z> {
        AuthorizedCaller { binding: self }
    }

    /// Returns whether the host has revoked this binding.
    #[must_use]
    pub fn is_revoked(&self) -> bool {
        self.controller.revoked()
    }
}

/// Complete authorized binding and its host-held revocation controller.
pub struct AuthorizedBound<CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static, Z> {
    /// Callable binding without lifecycle authority.
    pub binding: AuthorizedBinding<CallerContext, Auth, Z>,
    /// Host-held lifecycle authority for this binding.
    pub controller: Arc<BindingController>,
}

/// Atomic result of binding an installation with host authorization.
pub enum AuthorizedBindResult<CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static, Z> {
    /// A complete callable binding.
    Bound(Box<AuthorizedBound<CallerContext, Auth, Z>>),
    /// At least one selection could not be realized.
    Unrealized(UnrealizedReport),
}

/// Atomically binds a projection and installs an authorizer for each invocation.
pub fn bind_authorized<CallerContext, Auth, Z>(
    projection: &Projection,
    installation: &Installation<Auth>,
    authorizer: Z,
) -> AuthorizedBindResult<CallerContext, Auth, Z>
where
    CallerContext: Sync + ?Sized,
    Auth: Send + Sync + 'static,
    Z: Authorizer<CallerContext, Auth>,
{
    match bind(projection, installation, admit_all()) {
        BindResult::Unrealized(report) => AuthorizedBindResult::Unrealized(report),
        BindResult::Bound(bound) => {
            let controller = Arc::new(bound.controller);
            let binding = bound.binding;
            AuthorizedBindResult::Bound(Box::new(AuthorizedBound {
                binding: AuthorizedBinding {
                    inner: binding,
                    authorizer: Arc::new(authorizer),
                    controller: Arc::clone(&controller),
                    _caller_context: std::marker::PhantomData,
                },
                controller,
            }))
        }
    }
}

/// Caller capability that authorizes and narrows every invocation context.
pub struct AuthorizedCaller<'a, CallerContext: Sync + ?Sized, Auth: Send + Sync + 'static, Z> {
    binding: &'a AuthorizedBinding<CallerContext, Auth, Z>,
}

impl<CallerContext, Auth, Z> AuthorizedCaller<'_, CallerContext, Auth, Z>
where
    CallerContext: Sync + ?Sized,
    Auth: Send + Sync + 'static,
    Z: Authorizer<CallerContext, Auth>,
{
    /// Executes a direct interaction with the context derived by the authorizer.
    ///
    /// # Errors
    ///
    /// Returns the interaction's declared error or a stable binding, input, or
    /// authorization fault.
    pub async fn call<O>(
        &self,
        handle: &ProjectionHandle<O>,
        input: O,
        context: &CallerContext,
    ) -> Result<O::Output, CallerError<O::Error>>
    where
        O: Interaction + Sync,
    {
        if self.binding.is_revoked() {
            return Err(CallerError::Revoked);
        }
        let bound = self
            .selected(handle, InteractionMode::Direct)
            .map_err(map_call_preflight)?;
        let live = || !self.binding.is_revoked();
        let request = AuthorizationRequest::direct(context, bound, &input, &live);
        let auth = match self.binding.authorizer.authorize(request).await {
            AuthorizationDecision::Allow(auth) => auth,
            AuthorizationDecision::Deny { code } => return Err(CallerError::Denied { code }),
        };
        self.binding.inner.caller().call(&auth, handle, input).await
    }

    /// Creates a portable request with the context derived by the authorizer.
    ///
    /// # Errors
    ///
    /// Returns a stable binding, input, or authorization fault.
    pub async fn request<O>(
        &self,
        handle: &ProjectionHandle<O>,
        input: O,
        context: &CallerContext,
    ) -> Result<Value, RequestError>
    where
        O: Interaction,
    {
        if self.binding.is_revoked() {
            return Err(RequestError::Revoked);
        }
        let bound = self
            .selected(handle, InteractionMode::Request)
            .map_err(map_request_preflight)?;
        let portable = O::InputCodec::encode(&input)
            .and_then(O::InputCodec::normalize)
            .map_err(|_| RequestError::InvalidInput)?;
        let live = || !self.binding.is_revoked();
        let request = AuthorizationRequest::request(context, bound, &portable, &live);
        let auth = match self.binding.authorizer.authorize(request).await {
            AuthorizationDecision::Allow(auth) => auth,
            AuthorizationDecision::Deny { code } => return Err(RequestError::Denied { code }),
        };
        self.binding
            .inner
            .caller()
            .request(&auth, handle, input)
            .await
    }

    fn selected<O: Interaction>(
        &self,
        handle: &ProjectionHandle<O>,
        mode: InteractionMode,
    ) -> Result<&BoundInteraction, PreflightFault> {
        if handle.projection_digest() != self.binding.inner.manifest().projection_digest() {
            return Err(PreflightFault::WrongProjection);
        }
        if !handle.modes().contains(mode) {
            return Err(PreflightFault::ModeNotSelected);
        }
        let bound = self
            .binding
            .inner
            .manifest()
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
    ModeNotSelected,
    WrongProjection,
}

fn map_call_preflight<E: Error + 'static>(fault: PreflightFault) -> CallerError<E> {
    match fault {
        PreflightFault::ModeNotSelected => CallerError::ModeNotSelected,
        PreflightFault::WrongProjection => CallerError::WrongProjection,
    }
}

fn map_request_preflight(fault: PreflightFault) -> RequestError {
    match fault {
        PreflightFault::ModeNotSelected => RequestError::ModeNotSelected,
        PreflightFault::WrongProjection => RequestError::WrongProjection,
    }
}
