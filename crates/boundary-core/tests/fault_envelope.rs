//! A `Fault` enum marked `tag = "code", content = "details"` crosses a checked
//! Handoff as exactly `{ code, details }`, with no second wrapper.
#![cfg(feature = "derive")]
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

use std::sync::Mutex;

use boundary_core::{
    Fault, Handler, Interaction, PortableFault,
    handoff::{
        CheckedHandoff, HandoffInvocation, HandoffOutcome, HandoffTransport, RemoteCallError,
        RemoteCaller, TransportFault, checked_handoff,
    },
    lifecycle::{
        AdmitAll, BindResult, InstallationId, ProjectionModes, RealizationId, admit_all, bind,
        compile_interaction, direct_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, PartialEq, thiserror::Error, Serialize, Deserialize, JsonSchema, Fault)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
enum ItemError {
    #[error("not found")]
    #[fault(code = "item_not_found")]
    #[serde(rename = "item_not_found")]
    NotFound { id: String },
    #[error("gone")]
    #[fault(code = "item_gone")]
    #[serde(rename = "item_gone")]
    Gone,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "items.fetch", output = String, error = ItemError, reads("items"))]
struct Fetch {
    id: String,
}

struct FetchHandler;
impl Handler<Fetch> for FetchHandler {
    async fn handle(&self, _context: &(), request: Fetch) -> Result<String, ItemError> {
        match request.id.as_str() {
            "gone" => Err(ItemError::Gone),
            "ok" => Ok("value".to_owned()),
            _ => Err(ItemError::NotFound { id: request.id }),
        }
    }
}

struct Recording<'a> {
    checked: CheckedHandoff<'a, (), AdmitAll>,
    results: Mutex<Vec<Value>>,
}
impl HandoffTransport for Recording<'_> {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        let outcome = self
            .checked
            .invoke(invocation, &())
            .await
            .map_err(|_| TransportFault)?;
        let wire = serde_json::to_value(&outcome).map_err(|_| TransportFault)?;
        self.results
            .lock()
            .map_err(|_| TransportFault)?
            .push(wire["result"].clone());
        Ok(outcome)
    }
}

#[test]
fn envelope_enums_cross_a_handoff_as_code_and_details() -> Result<(), Box<dyn std::error::Error>> {
    let compiled = compile_interaction::<Fetch>()?;
    // The contract is the enum's own envelope, not a wrapper around it.
    let schema = compiled
        .descriptor()
        .contract()
        .error_schema()
        .ok_or("error schema missing")?;
    assert!(schema.accepts(&json!({ "code": "item_gone", "details": null })));
    assert!(schema.accepts(&json!({ "code": "item_not_found", "details": { "id": "x" } })));
    assert!(!schema.accepts(&json!({ "code": "item_not_found", "details": null })));
    assert!(!schema.accepts(&json!({ "code": "other", "details": null })));
    assert!(!schema.accepts(
        &json!({ "code": "item_gone", "details": { "code": "item_gone", "details": null } })
    ));

    let projection = project([select("items", &compiled, ProjectionModes::Direct)?])?;
    let installed = install(
        InstallationId::new("items/v1")?,
        [direct_realization(
            &compiled,
            RealizationId::new("items/fetch/v1")?,
            FetchHandler,
        )],
    )?;
    let BindResult::Bound(bound) = bind(&projection, &installed.installation, admit_all()) else {
        return Err("fixture did not bind".into());
    };
    let handle = projection.handles().get("items", &compiled)?;
    let caller = RemoteCaller::new(
        bound.binding.manifest().clone(),
        Recording {
            checked: checked_handoff(&bound.binding),
            results: Mutex::new(Vec::new()),
        },
    );
    for (id, expected, wire) in [
        (
            "missing",
            ItemError::NotFound {
                id: "missing".into(),
            },
            json!({ "kind": "declared-error", "code": "item_not_found", "details": { "id": "missing" } }),
        ),
        (
            "gone",
            ItemError::Gone,
            json!({ "kind": "declared-error", "code": "item_gone", "details": null }),
        ),
    ] {
        match block_on(caller.call(&handle, Fetch { id: id.into() })) {
            Err(RemoteCallError::Declared(error)) => {
                assert_eq!(error, expected);
                assert_eq!(error.code(), wire["code"]);
            }
            other => return Err(format!("declared error lost: {other:?}").into()),
        }
        let recorded = caller
            .transport()
            .results
            .lock()
            .map_err(|_| "poisoned")?
            .last()
            .cloned();
        assert_eq!(recorded, Some(wire));
    }
    assert_eq!(
        block_on(caller.call(&handle, Fetch { id: "ok".into() }))
            .ok()
            .as_deref(),
        Some("value")
    );
    Ok(())
}

#[test]
fn a_serde_tag_that_differs_from_the_fault_code_is_refused_at_runtime() {
    use boundary_core::{DeclaredErrorCodec, JsonCodec};
    #[derive(Debug, thiserror::Error, Serialize, Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields, tag = "code", content = "details")]
    enum Manual {
        #[error("a")]
        A,
    }
    impl PortableFault for Manual {
        const ENVELOPE: bool = true;
        fn code(&self) -> &'static str {
            "other"
        }
    }
    assert!(<JsonCodec<Manual> as DeclaredErrorCodec<Manual>>::encode(&Manual::A).is_err());
}
