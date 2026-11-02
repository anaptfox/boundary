//! Reviewed complete-error schema laws through the native Handoff client.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

use std::{
    error::Error,
    fmt,
    sync::atomic::{AtomicUsize, Ordering},
};

use boundary_core::{
    ChangeFootprint, ChangesState, DeclaredErrorCodec, Handler, Interaction, JsonCodec,
    PortableFault, PortableSchema, WireError,
    handoff::{
        CheckedHandoff, HandoffInvocation, HandoffOutcome, HandoffTransport, RemoteCallError,
        RemoteCaller, TransportFault, checked_handoff,
    },
    interaction_id,
    lifecycle::{
        AdmitAll, BindResult, InstallationId, ProjectionModes, RealizationId, admit_all, bind,
        compile_interaction, direct_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Probe {
    value: String,
}

#[derive(Debug)]
enum Fault {
    NotFound(String),
    Unavailable(String),
}

impl fmt::Display for Fault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
impl Error for Fault {}
impl PortableFault for Fault {
    fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Unavailable(_) => "unavailable",
        }
    }
}

fn details_schema(field: &str) -> Value {
    json!({ "type": "object", "properties": { field: { "type": "string" } },
        "required": [field], "additionalProperties": false })
}

struct FaultCodec;
impl DeclaredErrorCodec<Fault> for FaultCodec {
    fn schema() -> Result<Option<PortableSchema>, WireError> {
        PortableSchema::from_value(
            json!({ "anyOf": [details_schema("id"), details_schema("reason")] }),
        )
        .map(Some)
        .map_err(|error| WireError::Schema(error.to_string()))
    }
    fn declared_schema() -> Result<Option<PortableSchema>, WireError> {
        let variants: Vec<_> = [("not_found", "id"), ("unavailable", "reason")]
            .into_iter()
            .map(|(code, field)| {
                json!({ "type": "object",
                "properties": { "code": { "const": code }, "details": details_schema(field) },
                "required": ["code", "details"], "additionalProperties": false })
            })
            .collect();
        PortableSchema::from_value(json!({ "oneOf": variants }))
            .map(Some)
            .map_err(|error| WireError::Schema(error.to_string()))
    }
    fn encode(error: &Fault) -> Result<Value, WireError> {
        Ok(match error {
            Fault::NotFound(id) => json!({ "id": id }),
            Fault::Unavailable(reason) => json!({ "reason": reason }),
        })
    }
    fn decode(details: Value) -> Result<Fault, WireError> {
        let object = details
            .as_object()
            .ok_or_else(|| WireError::Decode("details must be an object".into()))?;
        if object.len() == 1 {
            if let Some(Value::String(id)) = object.get("id") {
                return Ok(Fault::NotFound(id.clone()));
            }
            if let Some(Value::String(reason)) = object.get("reason") {
                return Ok(Fault::Unavailable(reason.clone()));
            }
        }
        Err(WireError::Decode("invalid declared details".into()))
    }
}

impl Interaction for Probe {
    const ID: boundary_core::StaticInteractionId = interaction_id!("errors.probe");
    type Output = String;
    type Error = Fault;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = FaultCodec;
    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["probe"], &["probe"])
    }
}
struct ProbeHandler;
impl Handler<Probe> for ProbeHandler {
    async fn handle(&self, _context: &(), interaction: Probe) -> Result<String, Fault> {
        Ok(interaction.value)
    }
}

struct ReviewedTransport {
    value: Value,
    calls: AtomicUsize,
}
impl HandoffTransport for ReviewedTransport {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut wire = serde_json::to_value(invocation).map_err(|_| TransportFault)?;
        let object = wire.as_object_mut().ok_or(TransportFault)?;
        object.remove("input");
        object.insert("certainty".into(), json!("completed"));
        let mut result = self.value.as_object().ok_or(TransportFault)?.clone();
        result.insert("kind".into(), json!("declared-error"));
        object.insert("result".into(), Value::Object(result));
        serde_json::from_value(wire).map_err(|_| TransportFault)
    }
}

#[test]
fn reviewed_error_pairs_validate_and_reconstruct_without_retry() -> Result<(), Box<dyn Error>> {
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/declared-errors.json"
    ))?;
    let compiled = compile_interaction::<Probe>()?;
    let schema = compiled
        .descriptor()
        .contract()
        .error_schema()
        .ok_or("error declaration missing")?;
    assert_eq!(schema.as_value(), &evidence["schema"]);
    let projection = project([select("probe", &compiled, ProjectionModes::Direct)?])?;
    let installed = install(
        InstallationId::new("errors/reviewed/v1")?,
        [direct_realization(
            &compiled,
            RealizationId::new("errors/probe/v1")?,
            ProbeHandler,
        )],
    )?;
    let bound = match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => bound,
        BindResult::Unrealized(_) => return Err("reviewed error fixture did not bind".into()),
    };
    let handle = projection.handles().get("probe", &compiled)?;
    for case in evidence["cases"]
        .as_array()
        .ok_or("reviewed cases missing")?
    {
        let accepted = case["accepted"]
            .as_bool()
            .ok_or("case acceptance missing")?;
        assert_eq!(schema.accepts(&case["value"]), accepted, "{}", case["name"]);
        let caller = RemoteCaller::new(
            bound.binding.manifest().clone(),
            ReviewedTransport {
                value: case["value"].clone(),
                calls: AtomicUsize::new(0),
            },
        );
        let result = block_on(caller.call(
            &handle,
            Probe {
                value: "probe".into(),
            },
        ));
        if accepted {
            match result {
                Err(RemoteCallError::Declared(error)) => {
                    assert_eq!(error.code(), case["value"]["code"]);
                }
                other => return Err(format!("accepted pair lost declared error: {other:?}").into()),
            }
        } else {
            let error = result.err().ok_or("malformed error was accepted")?;
            assert_eq!(
                error.certainty(),
                boundary_core::lifecycle::InvocationCertainty::Unknown
            );
        }
        assert_eq!(caller.transport().calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

/// Both variants deliberately have identical details. Their code is required
/// for decoding; the native details-only decoder cannot guess a variant.
struct CodeFaultCodec;
impl DeclaredErrorCodec<Fault> for CodeFaultCodec {
    fn schema() -> Result<Option<PortableSchema>, WireError> {
        PortableSchema::from_value(details_schema("id"))
            .map(Some)
            .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn declared_schema() -> Result<Option<PortableSchema>, WireError> {
        PortableSchema::from_value(json!({ "type": "object",
            "properties": {
                "code": { "enum": ["not_found", "unavailable"] },
                "details": details_schema("id")
            },
            "required": ["code", "details"], "additionalProperties": false }))
        .map(Some)
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(error: &Fault) -> Result<Value, WireError> {
        let id = match error {
            Fault::NotFound(id) | Fault::Unavailable(id) => id,
        };
        Ok(json!({ "id": id }))
    }

    fn decode(_details: Value) -> Result<Fault, WireError> {
        Err(WireError::Decode("the declared code is required".into()))
    }

    fn decode_declared(code: &str, details: Value) -> Result<Fault, WireError> {
        let object = details
            .as_object()
            .filter(|object| object.len() == 1)
            .ok_or_else(|| WireError::Decode("closed error details required".into()))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| WireError::Decode("error id required".into()))?
            .to_owned();
        match code {
            "not_found" => Ok(Fault::NotFound(id)),
            "unavailable" => Ok(Fault::Unavailable(id)),
            _ => Err(WireError::Decode("unknown declared error code".into())),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct CodeProbe {
    unavailable: bool,
}
impl Interaction for CodeProbe {
    const ID: boundary_core::StaticInteractionId = interaction_id!("errors.code-probe");
    type Output = String;
    type Error = Fault;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = CodeFaultCodec;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["probe"], &["probe"])
    }
}
struct CodeProbeHandler;
impl Handler<CodeProbe> for CodeProbeHandler {
    async fn handle(&self, _context: &(), interaction: CodeProbe) -> Result<String, Fault> {
        let id = "same-details".to_owned();
        Err(if interaction.unavailable {
            Fault::Unavailable(id)
        } else {
            Fault::NotFound(id)
        })
    }
}

struct LiveTransport<'a> {
    checked: CheckedHandoff<'a, (), AdmitAll>,
    calls: AtomicUsize,
}
impl HandoffTransport for LiveTransport<'_> {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.checked
            .invoke(invocation, &())
            .await
            .map_err(|_| TransportFault)
    }
}

#[test]
fn live_code_discriminated_errors_normalize_without_details_only_decode()
-> Result<(), Box<dyn Error>> {
    assert!(CodeFaultCodec::decode(json!({ "id": "same-details" })).is_err());
    let compiled = compile_interaction::<CodeProbe>()?;
    let projection = project([select("probe", &compiled, ProjectionModes::Direct)?])?;
    let installed = install(
        InstallationId::new("errors/code-discriminated/v1")?,
        [direct_realization(
            &compiled,
            RealizationId::new("errors/code-probe/v1")?,
            CodeProbeHandler,
        )],
    )?;
    let bound = match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => bound,
        BindResult::Unrealized(_) => return Err("code-discriminated fixture did not bind".into()),
    };
    let handle = projection.handles().get("probe", &compiled)?;
    let caller = RemoteCaller::new(
        bound.binding.manifest().clone(),
        LiveTransport {
            checked: checked_handoff(&bound.binding),
            calls: AtomicUsize::new(0),
        },
    );
    for (unavailable, code) in [(false, "not_found"), (true, "unavailable")] {
        match block_on(caller.call(&handle, CodeProbe { unavailable })) {
            Err(RemoteCallError::Declared(error)) => {
                assert_eq!(error.code(), code);
                assert_eq!(
                    CodeFaultCodec::encode(&error)?,
                    json!({ "id": "same-details" })
                );
            }
            other => return Err(format!("live declared code lost: {other:?}").into()),
        }
    }
    assert_eq!(caller.transport().calls.load(Ordering::SeqCst), 2);
    Ok(())
}
