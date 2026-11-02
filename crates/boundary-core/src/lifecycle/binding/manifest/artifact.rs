use serde_json::{Map, Value};

use super::{BindingManifest, BoundInteraction};
use crate::{
    ProgramError,
    lifecycle::{BindingDigest, InteractionArity, InteractionMode},
};

const BINDING_DOMAIN: &str = "boundary.projection-binding/v1";

pub(super) fn binding_digest(manifest: &BindingManifest) -> Result<BindingDigest, ProgramError> {
    super::super::super::artifact::hash_artifact(BINDING_DOMAIN, &identity_value(manifest))
        .map(BindingDigest::from_hash)
}

fn identity_value(manifest: &BindingManifest) -> Value {
    let mut identity = Map::new();
    identity.insert("version".to_owned(), Value::from(1));
    identity.insert(
        "projectionDigest".to_owned(),
        Value::String(manifest.projection_digest.as_str().to_owned()),
    );
    identity.insert(
        "installationId".to_owned(),
        Value::String(manifest.installation_id.as_str().to_owned()),
    );
    identity.insert(
        "installationDigest".to_owned(),
        Value::String(manifest.installation_digest.as_str().to_owned()),
    );
    identity.insert(
        "expectedProgramDigest".to_owned(),
        Value::String(manifest.expected_program_digest.as_str().to_owned()),
    );
    identity.insert(
        "actualProgramDigest".to_owned(),
        Value::String(manifest.actual_program_digest.as_str().to_owned()),
    );
    identity.insert(
        "expectedProgram".to_owned(),
        super::super::super::artifact::program_value(&manifest.expected_program),
    );
    identity.insert(
        "actualProgram".to_owned(),
        super::super::super::artifact::program_value(&manifest.actual_program),
    );
    identity.insert("actualCatalog".to_owned(), manifest.actual_catalog.value());
    identity.insert(
        "interactions".to_owned(),
        Value::Array(
            manifest
                .interactions
                .iter()
                .map(interaction_value)
                .collect(),
        ),
    );
    Value::Object(identity)
}

fn interaction_value(interaction: &BoundInteraction) -> Value {
    let mut value = Map::new();
    value.insert("alias".to_owned(), Value::String(interaction.alias.clone()));
    value.insert(
        "interactionId".to_owned(),
        Value::String(interaction.interaction_id.as_str().to_owned()),
    );
    value.insert(
        "expectedContractDigest".to_owned(),
        Value::String(interaction.expected_contract_digest.as_str().to_owned()),
    );
    value.insert(
        "actualContractDigest".to_owned(),
        Value::String(interaction.actual_contract_digest.as_str().to_owned()),
    );
    value.insert(
        "inputArity".to_owned(),
        Value::from(match interaction.input_arity {
            InteractionArity::Zero => 0,
            InteractionArity::One => 1,
        }),
    );
    value.insert(
        "mode".to_owned(),
        Value::String(match interaction.mode {
            InteractionMode::Direct => "direct".to_owned(),
            InteractionMode::Request => "request".to_owned(),
        }),
    );
    value.insert(
        "realizationId".to_owned(),
        Value::String(interaction.realization_id.as_str().to_owned()),
    );
    if let Some(request) = &interaction.request {
        let mut request_value = Map::new();
        request_value.insert(
            "controlDigest".to_owned(),
            Value::String(request.control_digest.as_str().to_owned()),
        );
        request_value.insert(
            "previewSchema".to_owned(),
            request.preview_schema.as_value().clone(),
        );
        value.insert("request".to_owned(), Value::Object(request_value));
    }
    Value::Object(value)
}
