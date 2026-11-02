// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Focused laws for the durable projection and installation lifecycle.

use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use boundary_core::{
    ChangeFootprint, ChangesState, EmptyObjectCodec, Handler, Interaction, JsonCodec, NoError,
    PortableFault, PortableSchema, ReadFootprint, ReadOnly, SchemaType, WireCodec, WireError,
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, CallerError, InstallError,
        InstallationId, InvocationCertainty, InvocationResultKind, NativeDispatchFault,
        NativeDispatchOutcome, NativeDispatchRequest, NativeDispatcher, ProjectionModes,
        RealizationId, RequestCapability, RequestCapabilityFault, RequestControlDigest,
        RequestIdentity, UnrealizedReason, admit_all, bind, compile_interaction,
        declared_interaction, direct_realization, dispatch_realization,
        identified_request_realization, install, project, request_realization, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error as ThisError;

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct ChangeCounter {
    by: String,
    reject: bool,
}

#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, ThisError)]
#[serde(deny_unknown_fields)]
#[error("counter rejected: {code}")]
struct CounterFault {
    code: String,
}

impl PortableFault for CounterFault {
    fn code(&self) -> &'static str {
        match self.code.as_str() {
            "counter.invalid-input" => "counter.invalid-input",
            _ => "counter.rejected",
        }
    }
}

impl Interaction for ChangeCounter {
    const ID: boundary_core::StaticInteractionId =
        interaction_id!("tests.lifecycle.change-counter");

    type Output = String;
    type Error = CounterFault;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = JsonCodec<CounterFault>;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["counter"], &["counter"])
    }
}

struct AppContext {
    value: AtomicUsize,
    admissions: AtomicUsize,
    direct_calls: AtomicUsize,
    request_calls: AtomicUsize,
}

struct ContextAdmission;

impl Admission<AppContext> for ContextAdmission {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, AppContext>) -> AdmissionDecision {
        request.context().admissions.fetch_add(1, Ordering::SeqCst);
        AdmissionDecision::Admit
    }
}

struct ContextHandler;

impl Handler<ChangeCounter, AppContext> for ContextHandler {
    async fn handle(
        &self,
        context: &AppContext,
        interaction: ChangeCounter,
    ) -> Result<String, CounterFault> {
        let prior_calls = context.direct_calls.fetch_add(1, Ordering::SeqCst);
        if context.admissions.load(Ordering::SeqCst) <= prior_calls || interaction.reject {
            return Err(CounterFault {
                code: "counter.rejected".to_owned(),
            });
        }
        let by = interaction.by.parse::<usize>().map_err(|_| CounterFault {
            code: "counter.invalid-input".to_owned(),
        })?;
        Ok((context.value.fetch_add(by, Ordering::SeqCst) + by).to_string())
    }
}

struct ContextRequest;

impl RequestCapability<ChangeCounter, AppContext> for ContextRequest {
    async fn request<'a>(
        &'a self,
        context: &'a AppContext,
        interaction: ChangeCounter,
    ) -> Result<serde_json::Value, RequestCapabilityFault> {
        context.request_calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({
            "kind": "counter-change",
            "by": interaction.by,
            "observed": context.value.load(Ordering::SeqCst),
        }))
    }
}

#[test]
fn projection_rejects_an_empty_selection() {
    assert!(project([]).is_ok());
}

#[test]
fn projection_aliases_have_no_rust_only_length_cap() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let alias = "a".repeat(512);
    let projection = project([select(&alias, &interaction, ProjectionModes::Direct)?])?;
    assert_eq!(projection.manifest().interactions()[0].alias(), alias);
    Ok(())
}

#[test]
fn projection_is_durable_and_context_is_borrowed_per_invocation() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select(
        "change",
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let encoded = serde_json::to_string(&projection)?;
    let projection: boundary_core::lifecycle::Projection = serde_json::from_str(&encoded)?;
    let handle = projection.handles().get("change", &interaction)?;
    let installation = install(
        InstallationId::new("host/install/context-v1")?,
        [
            direct_realization(
                &interaction,
                RealizationId::new("host/direct/context-v1")?,
                ContextHandler,
            ),
            identified_request_realization(
                &interaction,
                RealizationId::new("host/request/context-v1")?,
                RequestIdentity::new(
                    RequestControlDigest::parse(concat!(
                        "sha256:",
                        "1111111111111111111111111111111111111111111111111111111111111111"
                    ))?,
                    PortableSchema::of_type(boundary_core::SchemaType::Object),
                ),
                ContextRequest,
            ),
        ],
    )?;
    let binding = match bind(&projection, &installation.installation, ContextAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(unrealized) => {
            return Err(format!("unexpected unrealized binding: {:?}", unrealized.issues()).into());
        }
    };
    let context = AppContext {
        value: AtomicUsize::new(10),
        admissions: AtomicUsize::new(0),
        direct_calls: AtomicUsize::new(0),
        request_calls: AtomicUsize::new(0),
    };

    let output = block_on(binding.binding.caller().call(
        &context,
        &handle,
        ChangeCounter {
            by: "2".to_owned(),
            reject: false,
        },
    ))?;
    assert_eq!(output, "12");
    let request = block_on(binding.binding.caller().request(
        &context,
        &handle,
        ChangeCounter {
            by: "5".to_owned(),
            reject: false,
        },
    ))?;
    assert_eq!(
        request,
        json!({"kind": "counter-change", "by": "5", "observed": 12})
    );

    let rejected = block_on(binding.binding.caller().call(
        &context,
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: true,
        },
    ));
    if let Err(error) = &rejected {
        assert_eq!(error.certainty(), InvocationCertainty::Completed);
        assert_eq!(error.result_kind(), InvocationResultKind::DeclaredError);
    }
    match rejected {
        Err(CallerError::Declared(error)) => {
            assert_eq!(error.code, "counter.rejected");
        }
        other => return Err(format!("unexpected declared result: {other:?}").into()),
    }
    assert_eq!(context.admissions.load(Ordering::SeqCst), 3);
    assert_eq!(context.direct_calls.load(Ordering::SeqCst), 2);
    assert_eq!(context.request_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn bind_is_all_or_nothing_across_selected_modes() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select(
        "change",
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let installation = install(
        InstallationId::new("host/install/direct-only")?,
        [direct_realization(
            &interaction,
            RealizationId::new("host/direct/only")?,
            ContextHandler,
        )],
    )?;

    match bind(&projection, &installation.installation, ContextAdmission) {
        BindResult::Unrealized(unrealized) => {
            assert!(
                unrealized
                    .issues()
                    .iter()
                    .any(|issue| issue.alias() == "change"
                        && issue.reason() == UnrealizedReason::MissingRequest
                        && issue.mode()
                            == Some(boundary_core::lifecycle::InteractionMode::Request))
            );
        }
        BindResult::Bound(_) => {
            return Err("partial installation unexpectedly became callable".into());
        }
    }
    Ok(())
}

#[test]
fn declared_but_unrealized_interaction_reports_the_exact_missing_mode() -> Result<(), Box<dyn Error>>
{
    let interaction = compile_interaction::<ChangeCounter>()?;
    let direct_projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
    let request_projection = project([select("change", &interaction, ProjectionModes::Request)?])?;
    let installed = install::<()>(
        InstallationId::new("host/install/declared-only")?,
        [declared_interaction(&interaction)],
    )?;

    assert_eq!(
        installed
            .installation
            .manifest()
            .program()
            .interactions()
            .len(),
        1
    );
    let availability = installed
        .installation
        .manifest()
        .catalog()
        .interaction(interaction.descriptor().contract().id())
        .ok_or("declared interaction missing from catalog")?;
    assert!(availability.direct().is_none());
    assert!(availability.request().is_none());

    for (projection, expected_reason, expected_mode) in [
        (
            &direct_projection,
            UnrealizedReason::MissingDirect,
            boundary_core::lifecycle::InteractionMode::Direct,
        ),
        (
            &request_projection,
            UnrealizedReason::MissingRequest,
            boundary_core::lifecycle::InteractionMode::Request,
        ),
    ] {
        match bind(projection, &installed.installation, admit_all()) {
            BindResult::Unrealized(report) => assert!(report.issues().iter().any(|issue| {
                issue.reason() == expected_reason && issue.mode() == Some(expected_mode)
            })),
            BindResult::Bound(_) => return Err("unrealized declaration became callable".into()),
        }
    }
    Ok(())
}

#[test]
fn request_mode_requires_exact_portable_control_identity() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select("change", &interaction, ProjectionModes::Request)?])?;
    let installation = install(
        InstallationId::new("host/install/unidentified-request")?,
        [request_realization(
            &interaction,
            RealizationId::new("host/request/unidentified")?,
            ContextRequest,
        )],
    )?;

    match bind(&projection, &installation.installation, ContextAdmission) {
        BindResult::Unrealized(report) => {
            assert!(report.issues().iter().any(|issue| {
                issue.reason() == UnrealizedReason::MismatchedRequestIdentity
                    && issue.mode() == Some(boundary_core::lifecycle::InteractionMode::Request)
            }));
        }
        BindResult::Bound(_) => {
            return Err("unidentified request capability became portable".into());
        }
    }
    Ok(())
}

#[test]
fn installation_rejects_reused_realization_identity_across_modes() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let realization_id = RealizationId::new("host/realization/reused")?;
    let result = install(
        InstallationId::new("host/install/duplicate-realization")?,
        [
            direct_realization(&interaction, realization_id.clone(), ContextHandler),
            request_realization(&interaction, realization_id.clone(), ContextRequest),
        ],
    );
    assert!(matches!(
        result,
        Err(InstallError::DuplicateRealization(id)) if id == realization_id
    ));
    Ok(())
}

struct OffsetHandler(usize);

impl Handler<ChangeCounter> for OffsetHandler {
    async fn handle(
        &self,
        _context: &(),
        interaction: ChangeCounter,
    ) -> Result<String, CounterFault> {
        let by = interaction.by.parse::<usize>().map_err(|_| CounterFault {
            code: "counter.invalid-input".to_owned(),
        })?;
        Ok((by + self.0).to_string())
    }
}

#[test]
fn binding_pins_one_installation_and_honors_host_revocation() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
    let handle = projection.handles().get("change", &interaction)?;
    let old = install(
        InstallationId::new("host/install/old")?,
        [direct_realization(
            &interaction,
            RealizationId::new("host/direct/old")?,
            OffsetHandler(1),
        )],
    )?;
    let replacement = install(
        InstallationId::new("host/install/replacement")?,
        [direct_realization(
            &interaction,
            RealizationId::new("host/direct/replacement")?,
            OffsetHandler(100),
        )],
    )?;
    let old_binding = match bind(&projection, &old.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("old installation did not bind".into()),
    };
    let replacement_binding = match bind(&projection, &replacement.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("replacement installation did not bind".into()),
    };

    let old_value = block_on(old_binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ))?;
    let replacement_value = block_on(replacement_binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ))?;
    assert_eq!(old_value, "2");
    assert_eq!(replacement_value, "101");

    assert!(old.controller.revoke());
    assert!(!old.controller.revoke());
    assert!(old.controller.revoked());
    let revoked = block_on(old_binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ));
    assert!(matches!(revoked, Err(CallerError::Revoked)));
    assert!(replacement_binding.controller.revoke());
    assert!(!replacement_binding.controller.revoke());
    assert!(replacement_binding.controller.revoked());
    let revoked = block_on(replacement_binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ));
    assert!(matches!(revoked, Err(CallerError::Revoked)));
    Ok(())
}

struct InvalidDispatcher;

impl NativeDispatcher for InvalidDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        Ok(NativeDispatchOutcome::Returned(json!(false)))
    }
}

struct DeclaredDispatcher;

impl NativeDispatcher for DeclaredDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        Ok(NativeDispatchOutcome::Declared(json!({
            "code": "counter.remote-rejected"
        })))
    }
}

struct PortableDispatcherAdmission;

impl Admission for PortableDispatcherAdmission {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, ()>) -> AdmissionDecision {
        if request.native_input::<ChangeCounter>().is_none()
            && request.portable_input() == Some(&json!({"by": "1", "reject": false}))
        {
            AdmissionDecision::Admit
        } else {
            AdmissionDecision::Deny {
                code: "policy.expected-portable-input".to_owned(),
            }
        }
    }
}

#[test]
fn invalid_native_dispatch_output_is_an_unknown_fault() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
    let handle = projection.handles().get("change", &interaction)?;
    let installation = install(
        InstallationId::new("host/install/dispatcher")?,
        [dispatch_realization(
            &interaction,
            RealizationId::new("host/dispatch/v1")?,
            Arc::new(InvalidDispatcher),
        )],
    )?;
    let binding = match bind(
        &projection,
        &installation.installation,
        PortableDispatcherAdmission,
    ) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("dispatcher installation did not bind".into()),
    };

    let result = block_on(binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ));
    match result {
        Err(error @ CallerError::Unknown) => {
            assert_eq!(error.certainty(), InvocationCertainty::Unknown);
            assert_eq!(error.result_kind(), InvocationResultKind::Fault);
        }
        other => return Err(format!("unexpected dispatcher result: {other:?}").into()),
    }
    Ok(())
}

#[test]
fn dynamic_dispatch_preserves_the_typed_declared_error() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
    let handle = projection.handles().get("change", &interaction)?;
    let installation = install(
        InstallationId::new("host/install/declared-dispatcher")?,
        [dispatch_realization(
            &interaction,
            RealizationId::new("host/dispatch/declared-v1")?,
            Arc::new(DeclaredDispatcher),
        )],
    )?;
    let binding = match bind(
        &projection,
        &installation.installation,
        PortableDispatcherAdmission,
    ) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("declared dispatcher did not bind".into()),
    };

    let result = block_on(binding.binding.caller().call(
        &(),
        &handle,
        ChangeCounter {
            by: "1".to_owned(),
            reject: false,
        },
    ));

    match result {
        Err(error @ CallerError::Declared(_)) => {
            assert_eq!(error.certainty(), InvocationCertainty::Completed);
            let CallerError::Declared(error) = error else {
                return Err("declared result changed while inspected".into());
            };
            assert_eq!(error.code, "counter.remote-rejected");
        }
        other => return Err(format!("unexpected dispatcher result: {other:?}").into()),
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum BoundedDispatchBehavior {
    Denied,
    NotStarted,
    NotCompleted,
    Unknown,
}

struct BoundedDispatcher {
    behavior: BoundedDispatchBehavior,
    dispatches: Arc<AtomicUsize>,
    effects: Arc<AtomicUsize>,
}

impl NativeDispatcher for BoundedDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        match self.behavior {
            BoundedDispatchBehavior::Denied => Ok(NativeDispatchOutcome::Denied {
                code: "host.pre-effect-denial".to_owned(),
            }),
            BoundedDispatchBehavior::NotStarted => Err(NativeDispatchFault::NotStarted),
            BoundedDispatchBehavior::NotCompleted => {
                self.effects.fetch_add(1, Ordering::SeqCst);
                Err(NativeDispatchFault::NotCompleted)
            }
            BoundedDispatchBehavior::Unknown => {
                self.effects.fetch_add(1, Ordering::SeqCst);
                Err(NativeDispatchFault::Unknown)
            }
        }
    }
}

#[test]
fn native_dispatch_preserves_denial_and_bounded_fault_certainty() -> Result<(), Box<dyn Error>> {
    let cases = [
        (
            BoundedDispatchBehavior::Denied,
            InvocationCertainty::NotStarted,
            0,
        ),
        (
            BoundedDispatchBehavior::NotStarted,
            InvocationCertainty::NotStarted,
            0,
        ),
        (
            BoundedDispatchBehavior::NotCompleted,
            InvocationCertainty::NotCompleted,
            1,
        ),
        (
            BoundedDispatchBehavior::Unknown,
            InvocationCertainty::Unknown,
            1,
        ),
    ];
    for (index, (behavior, certainty, expected_effects)) in cases.into_iter().enumerate() {
        let interaction = compile_interaction::<ChangeCounter>()?;
        let projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
        let handle = projection.handles().get("change", &interaction)?;
        let dispatches = Arc::new(AtomicUsize::new(0));
        let effects = Arc::new(AtomicUsize::new(0));
        let installation = install(
            InstallationId::new(format!("host/install/bounded-dispatch/{index}"))?,
            [dispatch_realization(
                &interaction,
                RealizationId::new(format!("host/dispatch/bounded/{index}"))?,
                Arc::new(BoundedDispatcher {
                    behavior,
                    dispatches: Arc::clone(&dispatches),
                    effects: Arc::clone(&effects),
                }),
            )],
        )?;
        let binding = match bind(
            &projection,
            &installation.installation,
            PortableDispatcherAdmission,
        ) {
            BindResult::Bound(binding) => binding,
            BindResult::Unrealized(_) => return Err("bounded dispatcher did not bind".into()),
        };
        let result = block_on(binding.binding.caller().call(
            &(),
            &handle,
            ChangeCounter {
                by: "1".to_owned(),
                reject: false,
            },
        ));
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        assert_eq!(effects.load(Ordering::SeqCst), expected_effects);
        match (behavior, result) {
            (BoundedDispatchBehavior::Denied, Err(CallerError::Denied { code })) => {
                assert_eq!(code, "host.pre-effect-denial");
            }
            (BoundedDispatchBehavior::NotStarted, Err(error @ CallerError::NotStarted))
            | (BoundedDispatchBehavior::NotCompleted, Err(error @ CallerError::NotCompleted))
            | (BoundedDispatchBehavior::Unknown, Err(error @ CallerError::Unknown)) => {
                assert_eq!(error.certainty(), certainty);
                assert_eq!(error.result_kind(), InvocationResultKind::Fault);
            }
            (_, other) => return Err(format!("unexpected bounded result: {other:?}").into()),
        }
    }
    Ok(())
}

#[derive(Debug)]
struct TypedOnly {
    value: u32,
}

struct TypedInputCodec;
struct TypedOutputCodec;

impl WireCodec<TypedOnly> for TypedInputCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        Ok(PortableSchema::of_type(SchemaType::Object))
    }

    fn encode(_value: &TypedOnly) -> Result<serde_json::Value, WireError> {
        Err(WireError::Encode(
            "typed input must not be serialized".to_owned(),
        ))
    }

    fn decode(_value: serde_json::Value) -> Result<TypedOnly, WireError> {
        Err(WireError::Decode(
            "typed input must not be deserialized".to_owned(),
        ))
    }
}

impl WireCodec<u32> for TypedOutputCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        Ok(PortableSchema::of_type(SchemaType::Integer))
    }

    fn encode(_value: &u32) -> Result<serde_json::Value, WireError> {
        Err(WireError::Encode(
            "typed output must not be serialized".to_owned(),
        ))
    }

    fn decode(_value: serde_json::Value) -> Result<u32, WireError> {
        Err(WireError::Decode(
            "typed output must not be deserialized".to_owned(),
        ))
    }
}

impl Interaction for TypedOnly {
    const ID: boundary_core::StaticInteractionId = interaction_id!("tests.lifecycle.typed-only");

    type Output = u32;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = TypedInputCodec;
    type OutputCodec = TypedOutputCodec;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["counter"])
    }
}

struct TypedHandler;

impl Handler<TypedOnly> for TypedHandler {
    async fn handle(&self, _context: &(), interaction: TypedOnly) -> Result<u32, NoError> {
        Ok(interaction.value + 1)
    }
}

struct TypedAdmission;

impl Admission for TypedAdmission {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, ()>) -> AdmissionDecision {
        match request.native_input::<TypedOnly>() {
            Some(interaction) if interaction.value == 41 && request.portable_input().is_none() => {
                AdmissionDecision::Admit
            }
            _ => AdmissionDecision::Deny {
                code: "policy.invalid-native-input".to_owned(),
            },
        }
    }
}

#[test]
fn typed_direct_call_does_not_cross_a_wire_codec() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<TypedOnly>()?;
    let projection = project([select("typed", &interaction, ProjectionModes::Direct)?])?;
    let handle = projection.handles().get("typed", &interaction)?;
    let installation = install(
        InstallationId::new("host/install/typed")?,
        [direct_realization(
            &interaction,
            RealizationId::new("host/direct/typed")?,
            TypedHandler,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, TypedAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("typed installation did not bind".into()),
    };

    let output = block_on(
        binding
            .binding
            .caller()
            .call(&(), &handle, TypedOnly { value: 41 }),
    )?;

    assert_eq!(output, 42);
    Ok(())
}

struct DenyAdmission;

impl Admission<AppContext> for DenyAdmission {
    async fn admit<'a>(&'a self, _request: AdmissionRequest<'a, AppContext>) -> AdmissionDecision {
        AdmissionDecision::Deny {
            code: "policy.denied".to_owned(),
        }
    }
}

#[test]
fn denial_happens_before_the_direct_realization() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<ChangeCounter>()?;
    let projection = project([select("change", &interaction, ProjectionModes::Direct)?])?;
    let handle = projection.handles().get("change", &interaction)?;
    let installation = install(
        InstallationId::new("host/install/denial")?,
        [direct_realization(
            &interaction,
            RealizationId::new("host/direct/denial")?,
            ContextHandler,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, DenyAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("denial installation did not bind".into()),
    };
    let context = AppContext {
        value: AtomicUsize::new(10),
        admissions: AtomicUsize::new(0),
        direct_calls: AtomicUsize::new(0),
        request_calls: AtomicUsize::new(0),
    };

    let result = block_on(binding.binding.caller().call(
        &context,
        &handle,
        ChangeCounter {
            by: "2".to_owned(),
            reject: false,
        },
    ));

    assert!(matches!(
        result,
        Err(CallerError::Denied { code }) if code == "policy.denied"
    ));
    assert_eq!(context.value.load(Ordering::SeqCst), 10);
    assert_eq!(context.direct_calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct DifferentCounter {
    by: String,
}

impl Interaction for DifferentCounter {
    const ID: boundary_core::StaticInteractionId =
        interaction_id!("tests.lifecycle.change-counter");

    type Output = bool;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<bool>;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["counter"])
    }
}

struct DifferentHandler;

impl Handler<DifferentCounter> for DifferentHandler {
    async fn handle(&self, _context: &(), interaction: DifferentCounter) -> Result<bool, NoError> {
        Ok(!interaction.by.is_empty())
    }
}

#[test]
fn binding_rejects_the_same_id_with_a_different_contract() -> Result<(), Box<dyn Error>> {
    let desired = compile_interaction::<ChangeCounter>()?;
    let installed = compile_interaction::<DifferentCounter>()?;
    let projection = project([select("change", &desired, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("host/install/different-contract")?,
        [direct_realization(
            &installed,
            RealizationId::new("host/direct/different-contract")?,
            DifferentHandler,
        )],
    )?;

    match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Unrealized(report) => assert!(report.issues().iter().any(|issue| {
            issue.alias() == "change" && issue.reason() == UnrealizedReason::IncompatibleContract
        })),
        BindResult::Bound(_) => return Err("different contract unexpectedly bound".into()),
    }
    Ok(())
}

#[derive(Debug)]
struct NativeName(String);

struct NativeNameCodec;

impl WireCodec<NativeName> for NativeNameCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        Ok(PortableSchema::of_type(SchemaType::String))
    }

    fn encode(value: &NativeName) -> Result<serde_json::Value, WireError> {
        Ok(serde_json::Value::String(value.0.clone()))
    }

    fn decode(value: serde_json::Value) -> Result<NativeName, WireError> {
        value
            .as_str()
            .map(|name| NativeName(name.to_owned()))
            .ok_or_else(|| WireError::Decode("name must be a string".to_owned()))
    }
}

#[test]
fn custom_codec_supports_a_distinct_native_representation() -> Result<(), Box<dyn Error>> {
    let encoded = NativeNameCodec::encode(&NativeName("Ada".to_owned()))?;
    let decoded = NativeNameCodec::decode(encoded)?;

    assert_eq!(decoded.0, "Ada");
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ZeroInput;

#[test]
fn zero_input_codec_is_exactly_an_empty_object() -> Result<(), Box<dyn Error>> {
    let encoded = EmptyObjectCodec::<ZeroInput>::encode(&ZeroInput)?;
    let decoded = EmptyObjectCodec::<ZeroInput>::decode(encoded.clone())?;

    assert_eq!(encoded, json!({}));
    assert_eq!(decoded, ZeroInput);
    assert!(EmptyObjectCodec::<ZeroInput>::decode(serde_json::Value::Null).is_err());
    Ok(())
}
