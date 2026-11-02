use serde_json::{Map, Value};

use super::{InteractionArity, ProjectedInteraction, ProjectionModes};
use crate::{Program, ProgramError, lifecycle::ProjectionDigest};

const PROJECTION_DOMAIN: &str = "boundary.projection/v1";

pub(super) fn projection_digest(
    program: &Program,
    interactions: &[ProjectedInteraction],
) -> Result<ProjectionDigest, ProgramError> {
    let mut identity = Map::new();
    identity.insert(
        "program".to_owned(),
        Value::String(program.digest().as_str().to_owned()),
    );
    identity.insert(
        "interactions".to_owned(),
        Value::Array(interactions.iter().map(interaction_identity).collect()),
    );
    super::super::artifact::hash_artifact(PROJECTION_DOMAIN, &Value::Object(identity))
        .map(ProjectionDigest::from_hash)
}

fn interaction_identity(interaction: &ProjectedInteraction) -> Value {
    let mut selected = Map::new();
    selected.insert("alias".to_owned(), Value::String(interaction.alias.clone()));
    selected.insert(
        "interaction".to_owned(),
        Value::String(interaction.interaction_id.as_str().to_owned()),
    );
    selected.insert(
        "contract".to_owned(),
        Value::String(interaction.expected_contract_digest.as_str().to_owned()),
    );
    selected.insert(
        "arity".to_owned(),
        Value::String(match interaction.input_arity {
            InteractionArity::Zero => "zero".to_owned(),
            InteractionArity::One => "one".to_owned(),
        }),
    );
    selected.insert(
        "modes".to_owned(),
        Value::String(match interaction.modes {
            ProjectionModes::Direct => "direct".to_owned(),
            ProjectionModes::Request => "request".to_owned(),
            ProjectionModes::DirectAndRequest => "direct-and-request".to_owned(),
        }),
    );
    Value::Object(selected)
}
