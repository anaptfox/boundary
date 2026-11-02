// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Native version 1 Handoff preservation and hostile-boundary proofs.

use std::{
    error::Error,
    sync::atomic::{AtomicUsize, Ordering},
};

use boundary_core::{
    ChangeFootprint, ChangesState, Handler, Interaction, JsonCodec, PortableFault, PortableSchema,
    WireCodec, WireError,
    handoff::{
        CheckedHandoff, HandoffDiagnosticCode, HandoffFaultCause, HandoffInvocation,
        HandoffOutcome, HandoffResult, HandoffTransport, RemoteCallError, RemoteCaller,
        TransportFault, checked_handoff,
    },
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, InstallationId,
        InteractionMode, InvocationCertainty, NativeDispatchFault, NativeDispatchOutcome,
        NativeDispatchRequest, NativeDispatcher, ProjectionModes, RealizationId, RequestCapability,
        RequestCapabilityFault, RequestControlDigest, RequestIdentity, admit_all, bind,
        compile_interaction, direct_realization, dispatch_realization,
        identified_request_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error as ThisError;

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Echo {
    value: String,
    reject: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct Echoed {
    value: String,
}

struct EchoedCodec;

impl WireCodec<Echoed> for EchoedCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": { "value": { "type": "string" } },
            "required": ["value"],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &Echoed) -> Result<Value, WireError> {
        Ok(json!({ "value": value.value }))
    }

    fn decode(value: Value) -> Result<Echoed, WireError> {
        let Value::Object(mut object) = value else {
            return Err(WireError::Decode("output must be an object".to_owned()));
        };
        if object.len() != 1 {
            return Err(WireError::Decode("output keys are invalid".to_owned()));
        }
        match object.remove("value") {
            Some(Value::String(value)) => Ok(Echoed { value }),
            _ => Err(WireError::Decode(
                "output value must be a string".to_owned(),
            )),
        }
    }
}

#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, ThisError)]
#[serde(deny_unknown_fields)]
#[error("echo rejected: {code}")]
struct EchoFault {
    code: String,
}

impl PortableFault for EchoFault {
    fn code(&self) -> &'static str {
        "echo.rejected"
    }
}

impl Interaction for Echo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("tests.handoff.echo");

    type Output = Echoed;
    type Error = EchoFault;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = EchoedCodec;
    type ErrorCodec = JsonCodec<EchoFault>;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["echo"], &["echo"])
    }
}

#[derive(Default)]
struct TestContext {
    admissions: AtomicUsize,
    direct: AtomicUsize,
    requests: AtomicUsize,
    allow: bool,
}

struct TestAdmission;

impl Admission<TestContext> for TestAdmission {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, TestContext>) -> AdmissionDecision {
        request.context().admissions.fetch_add(1, Ordering::SeqCst);
        assert!(request.portable_input().is_some());
        if request.context().allow {
            AdmissionDecision::Admit
        } else {
            AdmissionDecision::Deny {
                code: "policy.denied".to_owned(),
            }
        }
    }
}

struct EchoHandler;

impl Handler<Echo, TestContext> for EchoHandler {
    async fn handle(&self, context: &TestContext, interaction: Echo) -> Result<Echoed, EchoFault> {
        context.direct.fetch_add(1, Ordering::SeqCst);
        if interaction.reject {
            Err(EchoFault {
                code: "echo.rejected".to_owned(),
            })
        } else {
            Ok(Echoed {
                value: interaction.value,
            })
        }
    }
}

struct EchoRequest;

impl RequestCapability<Echo, TestContext> for EchoRequest {
    async fn request<'a>(
        &'a self,
        context: &'a TestContext,
        interaction: Echo,
    ) -> Result<Value, RequestCapabilityFault> {
        context.requests.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "proposal": interaction.value }))
    }
}

struct InvalidEchoRequest;

impl RequestCapability<Echo, TestContext> for InvalidEchoRequest {
    async fn request<'a>(
        &'a self,
        context: &'a TestContext,
        _interaction: Echo,
    ) -> Result<Value, RequestCapabilityFault> {
        context.requests.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "proposal": 42 }))
    }
}

struct Loopback<'a> {
    checked: &'a CheckedHandoff<'a, TestContext, TestAdmission>,
    context: &'a TestContext,
}

impl HandoffTransport for Loopback<'_> {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        self.checked
            .invoke(invocation, self.context)
            .await
            .map_err(|_| TransportFault)
    }
}

fn preview_schema() -> Result<PortableSchema, Box<dyn Error>> {
    Ok(PortableSchema::from_value(json!({
        "type": "object",
        "properties": { "proposal": { "type": "string" } },
        "required": ["proposal"],
        "additionalProperties": false
    }))?)
}

#[test]
fn remote_caller_preserves_typed_direct_declared_request_and_admission()
-> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select(
        "echo",
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let installation = install(
        InstallationId::new("installation:handoff:v1")?,
        [
            direct_realization(
                &interaction,
                RealizationId::new("realization:echo:direct:v1")?,
                EchoHandler,
            ),
            identified_request_realization(
                &interaction,
                RealizationId::new("realization:echo:request:v1")?,
                RequestIdentity::new(
                    RequestControlDigest::parse(concat!(
                        "sha256:",
                        "4444444444444444444444444444444444444444444444444444444444444444"
                    ))?,
                    preview_schema()?,
                ),
                EchoRequest,
            ),
        ],
    )?;
    let binding = match bind(&projection, &installation.installation, TestAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let context = TestContext {
        allow: true,
        ..TestContext::default()
    };
    let checked = checked_handoff(&binding.binding);
    let caller = RemoteCaller::new(
        binding.binding.manifest().clone(),
        Loopback {
            checked: &checked,
            context: &context,
        },
    );
    let handle = projection.handles().get("echo", &interaction)?;

    let returned = block_on(caller.call(
        &handle,
        Echo {
            value: "hello".to_owned(),
            reject: false,
        },
    ))?;
    assert_eq!(returned.value, "hello");
    match block_on(caller.call(
        &handle,
        Echo {
            value: "no".to_owned(),
            reject: true,
        },
    )) {
        Err(RemoteCallError::Declared(error)) => assert_eq!(error.code, "echo.rejected"),
        _ => return Err("declared error lost its native type".into()),
    }
    let proposal = block_on(caller.request(
        &handle,
        Echo {
            value: "later".to_owned(),
            reject: false,
        },
    ))?;
    assert_eq!(proposal, json!({ "proposal": "later" }));
    assert_eq!(context.admissions.load(Ordering::SeqCst), 3);
    assert_eq!(context.direct.load(Ordering::SeqCst), 2);
    assert_eq!(context.requests.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn stale_or_invalid_invocations_fail_before_admission_and_dispatch() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("installation:hostile:v1")?,
        [direct_realization(
            &interaction,
            RealizationId::new("realization:hostile:v1")?,
            EchoHandler,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, TestAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let checked = checked_handoff(&binding.binding);
    let context = TestContext {
        allow: true,
        ..TestContext::default()
    };
    let mut stale = serde_json::to_value(HandoffInvocation::new(
        binding.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({ "value": "x", "reject": false }),
    )?)?;
    stale["realizationId"] = Value::String("realization:stale:v1".to_owned());
    let error = block_on(checked.invoke(serde_json::from_value(stale)?, &context))
        .err()
        .ok_or("stale realization was accepted")?;
    assert_eq!(error.code(), HandoffDiagnosticCode::StaleRealization);
    assert_eq!(context.admissions.load(Ordering::SeqCst), 0);

    let invalid = HandoffInvocation::new(
        binding.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({ "value": 42, "reject": false }),
    )?;
    let outcome = block_on(checked.invoke(invalid, &context))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::NotStarted);
    assert!(matches!(
        outcome.result(),
        HandoffResult::Fault { cause: HandoffFaultCause::InvalidInput, issues }
            if !issues.is_empty()
    ));
    assert_eq!(context.admissions.load(Ordering::SeqCst), 0);
    assert_eq!(context.direct.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn invalid_request_preview_is_request_failed_and_not_started() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Request)?])?;
    let installation = install(
        InstallationId::new("installation:request-preview:v1")?,
        [identified_request_realization(
            &interaction,
            RealizationId::new("realization:request-preview:v1")?,
            RequestIdentity::new(
                RequestControlDigest::parse(concat!(
                    "sha256:",
                    "5555555555555555555555555555555555555555555555555555555555555555"
                ))?,
                preview_schema()?,
            ),
            InvalidEchoRequest,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, TestAdmission) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let context = TestContext {
        allow: true,
        ..TestContext::default()
    };
    let invocation = HandoffInvocation::new(
        binding.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Request,
        json!({ "value": "review", "reject": false }),
    )?;
    let outcome = block_on(checked_handoff(&binding.binding).invoke(invocation, &context))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::NotStarted);
    assert!(matches!(
        outcome.result(),
        HandoffResult::Fault {
            cause: HandoffFaultCause::RequestFailed,
            issues
        } if issues.is_empty()
    ));
    assert_eq!(context.admissions.load(Ordering::SeqCst), 1);
    assert_eq!(context.requests.load(Ordering::SeqCst), 1);
    assert_eq!(context.direct.load(Ordering::SeqCst), 0);
    Ok(())
}

struct SecretDispatcher;

impl NativeDispatcher for SecretDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        Err(NativeDispatchFault::Unknown)
    }
}

struct InvalidOutputDispatcher;

impl NativeDispatcher for InvalidOutputDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        Ok(NativeDispatchOutcome::Returned(json!({ "value": 42 })))
    }
}

#[test]
fn realization_and_transport_failures_stay_sanitized_and_unknown() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("installation:fault:v1")?,
        [dispatch_realization(
            &interaction,
            RealizationId::new("realization:fault:v1")?,
            std::sync::Arc::new(SecretDispatcher),
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let checked = checked_handoff(&binding.binding);
    let invocation = HandoffInvocation::new(
        binding.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({ "value": "secret", "reject": false }),
    )?;
    let outcome = block_on(checked.invoke(invocation, &()))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::Unknown);
    assert!(matches!(
        outcome.result(),
        HandoffResult::Fault { cause: HandoffFaultCause::RealizationFailed, issues }
            if issues.is_empty()
    ));
    let encoded = serde_json::to_string(&outcome)?;
    assert!(!encoded.contains("secret"));
    assert!(!encoded.contains("dispatcher"));

    let caller = RemoteCaller::new(binding.binding.manifest().clone(), FailingTransport);
    let handle = projection.handles().get("echo", &interaction)?;
    let error = block_on(caller.call(
        &handle,
        Echo {
            value: "x".to_owned(),
            reject: false,
        },
    ))
    .err()
    .ok_or("transport failure was accepted")?;
    assert_eq!(error.certainty(), InvocationCertainty::Unknown);
    Ok(())
}

#[test]
fn invalid_direct_output_is_unknown_after_dispatch() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("installation:invalid-output:v1")?,
        [dispatch_realization(
            &interaction,
            RealizationId::new("realization:invalid-output:v1")?,
            std::sync::Arc::new(InvalidOutputDispatcher),
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let invocation = HandoffInvocation::new(
        binding.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({ "value": "invalid", "reject": false }),
    )?;
    let outcome = block_on(checked_handoff(&binding.binding).invoke(invocation, &()))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::Unknown);
    assert!(matches!(
        outcome.result(),
        HandoffResult::Fault {
            cause: HandoffFaultCause::InvalidRealizationOutcome,
            issues
        } if issues.is_empty()
    ));
    Ok(())
}

struct FailingTransport;

impl HandoffTransport for FailingTransport {
    async fn invoke(
        &self,
        _invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        Err(TransportFault)
    }
}

#[derive(Clone, Copy)]
enum Forgery {
    InvalidOutput,
    StaleRealization,
}

struct ForgedTransport(Forgery);

impl HandoffTransport for ForgedTransport {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        let mut wire = serde_json::to_value(invocation).map_err(|_| TransportFault)?;
        let Some(object) = wire.as_object_mut() else {
            return Err(TransportFault);
        };
        object.remove("input");
        object.insert("certainty".to_owned(), json!("completed"));
        object.insert(
            "result".to_owned(),
            json!({ "kind": "returned", "value": { "value": 42 } }),
        );
        if matches!(self.0, Forgery::StaleRealization) {
            object.insert("realizationId".to_owned(), json!("realization:forged:v1"));
        }
        serde_json::from_value(wire).map_err(|_| TransportFault)
    }
}

#[test]
fn remote_caller_rejects_hostile_output_schema_and_echoed_pin_drift() -> Result<(), Box<dyn Error>>
{
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("installation:client-hostile:v1")?,
        [direct_realization(
            &interaction,
            RealizationId::new("realization:client-hostile:v1")?,
            EchoHandler,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let handle = projection.handles().get("echo", &interaction)?;
    for forgery in [Forgery::InvalidOutput, Forgery::StaleRealization] {
        let caller =
            RemoteCaller::new(binding.binding.manifest().clone(), ForgedTransport(forgery));
        let result = block_on(caller.call(
            &handle,
            Echo {
                value: "x".to_owned(),
                reject: false,
            },
        ));
        assert!(matches!(result, Err(RemoteCallError::InvalidOutcome)));
    }
    Ok(())
}

/// Hostile transport reflects a structurally valid response with one changed pin.
struct ReviewedResponseTransport {
    field: String,
    replacement: Value,
    calls: AtomicUsize,
}

impl HandoffTransport for ReviewedResponseTransport {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut wire = serde_json::to_value(invocation).map_err(|_| TransportFault)?;
        let object = wire.as_object_mut().ok_or(TransportFault)?;
        object.remove("input");
        object.insert("certainty".to_owned(), json!("completed"));
        object.insert(
            "result".to_owned(),
            json!({"kind": "returned", "value": {"value": "ok"}}),
        );
        object.insert(self.field.clone(), self.replacement.clone());
        if self.field == "mode" {
            object.insert("certainty".to_owned(), json!("not-started"));
            object.insert(
                "result".to_owned(),
                json!({"kind": "denied", "code": "denied"}),
            );
        }
        serde_json::from_value(wire).map_err(|_| TransportFault)
    }
}

#[test]
fn reviewed_response_identity_laws_remain_unknown_without_retry() -> Result<(), Box<dyn Error>> {
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/handoff-response.json"
    ))?;
    let cases = evidence["cases"]
        .as_array()
        .ok_or("missing reviewed cases")?;
    assert_eq!(cases.len(), 7);
    let interaction = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &interaction, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("installation:response-laws:v1")?,
        [direct_realization(
            &interaction,
            RealizationId::new("realization:response-laws:v1")?,
            EchoHandler,
        )],
    )?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(_) => return Err("fixture did not bind".into()),
    };
    let handle = projection.handles().get("echo", &interaction)?;
    for case in cases {
        let field = case["field"].as_str().ok_or("missing field")?;
        let caller = RemoteCaller::new(
            binding.binding.manifest().clone(),
            ReviewedResponseTransport {
                field: field.to_owned(),
                replacement: case["replacement"].clone(),
                calls: AtomicUsize::new(0),
            },
        );
        let result = block_on(caller.call(
            &handle,
            Echo {
                value: "ok".to_owned(),
                reject: false,
            },
        ));
        let Err(error) = result else {
            return Err("changed response pin must be rejected".into());
        };
        assert!(
            matches!(error, RemoteCallError::InvalidOutcome),
            "{field}: {error}"
        );
        assert_eq!(error.certainty(), InvocationCertainty::Unknown, "{field}");
        assert_eq!(caller.transport().calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[test]
fn envelopes_reject_version_drift_and_illegal_certainty_combinations() {
    let base = json!({
        "version": 1,
        "bindingDigest": format!("sha256:{}", "1".repeat(64)),
        "installationId": "installation:wire:v1",
        "interactionId": "tests.handoff.echo",
        "expectedContractDigest": format!("sha256:{}", "2".repeat(64)),
        "actualContractDigest": format!("sha256:{}", "3".repeat(64)),
        "mode": "direct",
        "realizationId": "realization:wire:v1",
        "input": { "value": "x", "reject": false }
    });
    let mut zero = base.clone();
    zero["version"] = json!(0);
    assert!(serde_json::from_value::<HandoffInvocation>(zero).is_err());
    let mut unsupported = base.clone();
    unsupported["version"] = json!(99);
    assert!(serde_json::from_value::<HandoffInvocation>(unsupported).is_err());
    let mut unknown = base;
    unknown["extra"] = json!(true);
    assert!(serde_json::from_value::<HandoffInvocation>(unknown).is_err());

    let outcome = json!({
        "version": 1,
        "bindingDigest": format!("sha256:{}", "1".repeat(64)),
        "installationId": "installation:wire:v1",
        "interactionId": "tests.handoff.echo",
        "expectedContractDigest": format!("sha256:{}", "2".repeat(64)),
        "actualContractDigest": format!("sha256:{}", "3".repeat(64)),
        "mode": "direct",
        "realizationId": "realization:wire:v1",
        "certainty": "not-started",
        "result": { "kind": "returned", "value": { "value": "x" } }
    });
    assert!(serde_json::from_value::<HandoffOutcome>(outcome.clone()).is_err());
    let mut zero_outcome = outcome.clone();
    zero_outcome["version"] = json!(0);
    assert!(serde_json::from_value::<HandoffOutcome>(zero_outcome).is_err());
    let mut unsupported_outcome = outcome.clone();
    unsupported_outcome["version"] = json!(99);
    assert!(serde_json::from_value::<HandoffOutcome>(unsupported_outcome).is_err());
    let mut extra_outcome = outcome;
    extra_outcome["extra"] = json!(true);
    assert!(serde_json::from_value::<HandoffOutcome>(extra_outcome).is_err());

    let fault = |mode: &str, certainty: &str, cause: &str| {
        json!({
            "version": 1,
            "bindingDigest": format!("sha256:{}", "1".repeat(64)),
            "installationId": "installation:wire:v1",
            "interactionId": "tests.handoff.echo",
            "expectedContractDigest": format!("sha256:{}", "2".repeat(64)),
            "actualContractDigest": format!("sha256:{}", "3".repeat(64)),
            "mode": mode,
            "realizationId": "realization:wire:v1",
            "certainty": certainty,
            "result": { "kind": "fault", "cause": cause }
        })
    };
    for (mode, certainty, cause) in [
        ("direct", "not-started", "invalid-input"),
        ("request", "not-started", "revoked"),
        ("direct", "not-started", "admission-failed"),
        ("request", "not-started", "request-failed"),
        ("direct", "unknown", "invalid-realization-outcome"),
        ("direct", "not-started", "realization-failed"),
        ("direct", "not-completed", "realization-failed"),
        ("direct", "unknown", "realization-failed"),
        ("request", "unknown", "realization-failed"),
        ("request", "not-started", "invalid-invocation"),
    ] {
        assert!(serde_json::from_value::<HandoffOutcome>(fault(mode, certainty, cause)).is_ok());
    }
    for (mode, certainty, cause) in [
        ("direct", "not-started", "invalid-realization-outcome"),
        ("direct", "not-completed", "invalid-realization-outcome"),
        ("direct", "unknown", "admission-failed"),
        ("request", "not-completed", "revoked"),
        ("direct", "not-started", "request-failed"),
        ("request", "unknown", "invalid-realization-outcome"),
        ("request", "not-started", "realization-failed"),
        ("request", "not-completed", "realization-failed"),
    ] {
        assert!(serde_json::from_value::<HandoffOutcome>(fault(mode, certainty, cause)).is_err());
    }
}
