//! Shared composition evidence is consumed without another implementation's runtime.
use boundary_core::lifecycle::{
    InteractionPresentationOverride, InvocationObservation, present_projection, project,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error};

#[test]
fn observation_validates_certainty_and_rejects_payloads() -> Result<(), Box<dyn Error>> {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/composition.json"
    ))?;
    let value = vector["observation"].clone();
    let observed: InvocationObservation = serde_json::from_value(value.clone())?;
    assert_eq!(serde_json::to_value(observed)?, value);
    let mut invalid = value.clone();
    invalid["certainty"] = json!("completed");
    assert!(serde_json::from_value::<InvocationObservation>(invalid).is_err());
    let mut invalid = value;
    invalid["input"] = json!({"secret":"must not leak"});
    assert!(serde_json::from_value::<InvocationObservation>(invalid).is_err());
    Ok(())
}

#[test]
fn empty_presentation_is_stable_and_rejects_unselected_prose() -> Result<(), Box<dyn Error>> {
    let projection = project(Vec::new())?;
    let first = present_projection(&projection, &BTreeMap::new())?;
    assert_eq!(first.as_value()["interactions"], json!([]));
    assert_eq!(
        first.as_value()["projectionDigest"],
        json!(projection.manifest().projection_digest())
    );
    let mut overrides = BTreeMap::new();
    overrides.insert(
        "unselected".to_owned(),
        InteractionPresentationOverride::default(),
    );
    assert!(present_projection(&projection, &overrides).is_err());
    Ok(())
}
