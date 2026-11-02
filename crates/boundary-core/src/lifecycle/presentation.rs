use super::{InteractionMode, Projection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use thiserror::Error;

/// The only caller-authored overrides: prose, never execution facts.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionPresentationOverride {
    /// Optional display title.
    pub title: Option<String>,
    /// Optional agent-facing instructions.
    pub description: Option<String>,
}

/// Handler-free presentation with an independent content digest.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct ProjectionPresentation(Value);

impl ProjectionPresentation {
    /// Returns inspectable, immutable presentation JSON.
    #[must_use]
    pub const fn as_value(&self) -> &Value {
        &self.0
    }
}

/// Invalid presentation overrides or nonportable presentation data.
#[derive(Debug, Error)]
#[error("invalid projection presentation: {0}")]
pub struct PresentationError(String);

/// Derives selected schemas and footprints while allowing explicit prose overrides.
/// Request-only surfaces deliberately omit direct output schemas.
///
/// # Errors
/// Returns an error for unselected aliases or failed canonicalization.
pub fn present_projection(
    projection: &Projection,
    overrides: &BTreeMap<String, InteractionPresentationOverride>,
) -> Result<ProjectionPresentation, PresentationError> {
    let manifest = projection.manifest();
    if overrides
        .keys()
        .any(|alias| !manifest.interactions().iter().any(|op| op.alias() == alias))
    {
        return Err(PresentationError(
            "override alias is not selected".to_owned(),
        ));
    }
    let mut interactions = Vec::new();
    for selected in manifest.interactions() {
        let descriptor = manifest
            .program()
            .interaction(selected.interaction_id())
            .ok_or_else(|| PresentationError("missing descriptor".to_owned()))?;
        let contract = descriptor.contract();
        let prose = overrides.get(selected.alias());
        let title = prose
            .and_then(|p| p.title.as_deref())
            .or(descriptor.docs().summary())
            .unwrap_or(selected.alias());
        let description = prose
            .and_then(|p| p.description.as_deref())
            .or(descriptor.docs().description())
            .unwrap_or("");
        let mut interaction = json!({
            "alias":selected.alias(), "interactionId":selected.interaction_id(), "contractDigest":selected.expected_contract_digest(),
            "inputArity":selected.input_arity(), "modes":selected.modes(), "title":title, "description":description,
            "inputSchema":contract.input_schema(), "reads":contract.reads(), "changes":contract.changes()
        });
        if selected.modes().contains(InteractionMode::Direct) {
            interaction["directOutputSchema"] = serde_json::to_value(contract.output_schema())
                .map_err(|e| PresentationError(e.to_string()))?;
            if let Some(error) = contract.error_schema() {
                interaction["errorSchema"] =
                    serde_json::to_value(error).map_err(|e| PresentationError(e.to_string()))?;
            }
        }
        interactions.push(interaction);
    }
    let mut value = json!({"version":1,"projectionDigest":manifest.projection_digest(),"interactions":interactions});
    let hash = super::artifact::hash_artifact("boundary.projection-presentation/v1", &value)
        .map_err(|e| PresentationError(e.to_string()))?;
    value["presentationDigest"] = json!(super::identity::encode_hash(hash));
    Ok(ProjectionPresentation(value))
}
