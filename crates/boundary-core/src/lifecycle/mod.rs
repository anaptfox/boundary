//! Durable projections, immutable installations, and atomic caller bindings.

mod artifact;
mod binding;
mod compiled;
mod drafts;
mod identity;
mod installation;
mod projection;

pub(crate) use binding::PortableInvocationOutcome;
// Shared between sibling lifecycle modules; not public API.
pub use binding::{
    Admission, AdmissionDecision, AdmissionRequest, AdmitAll, BindResult, Binding,
    BindingController, BindingDescription, BindingDescriptionError, BindingManifest, Bound,
    BoundInteraction, BoundRequest, Caller, CallerError, CoordinatedInvocation, CoordinationError,
    CoordinationFuture, DescribedBindingInteraction, InvocationCertainty, InvocationContinuation,
    InvocationCoordinator, InvocationResultKind, RequestError, RestrictedAdmission,
    UnrealizedIssue, UnrealizedReason, UnrealizedReport, admit_all, bind, coordinate_binding,
    describe_binding, restrict_binding,
};
use compiled::ErasedInteraction;
pub use compiled::{CompiledInteraction, NativeInteraction, compile_interaction};
pub use drafts::{
    AcceptOutcome, DraftAuthor, DraftDecision, DraftFault, DraftProposer, DraftRejectReason,
    DraftRunner, DraftStore, ProposeOutcome, RejectOutcome, accept, propose, reject,
};
pub use identity::{
    BindingDigest, InstallationDigest, InstallationId, LifecycleDigestError,
    LifecycleIdentityError, ProjectionDigest, RealizationId, RequestControlDigest,
};
use installation::PinnedInstallation;
pub use installation::native::{
    NativeValueDispatcher, NativeValueFault, NativeValueOutcome, native_declared_interaction,
    native_direct_realization, native_request_realization,
};
pub use installation::{
    InstallError, Installation, InstallationAvailability, InstallationCatalog,
    InstallationContribution, InstallationController, InstallationManifest,
    InstallationRequestAvailability, Installed, InstalledInteraction, InteractionArity,
    InteractionMode, ModeAvailability, NativeDispatchFault, NativeDispatchOutcome,
    NativeDispatchRequest, NativeDispatcher, RequestCapability, RequestCapabilityFault,
    RequestIdentity, declared_interaction, direct_realization, dispatch_realization,
    identified_request_realization, install, observed_read_realization, request_realization,
};
pub use projection::{
    ProjectError, ProjectedInteraction, Projection, ProjectionHandle, ProjectionHandleError,
    ProjectionHandles, ProjectionManifest, ProjectionModes, ProjectionSelection, project, select,
    select_native,
};

mod observation;
mod presentation;
pub use observation::{InvocationObservation, ObservationError};
pub use presentation::{
    InteractionPresentationOverride, PresentationError, ProjectionPresentation, present_projection,
};
