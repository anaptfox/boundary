use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{InteractionDescriptor, Program, ProgramError, canonical_json};

pub(super) fn hash_artifact(domain: &str, identity: &Value) -> Result<[u8; 32], ProgramError> {
    let canonical = canonical_json(identity)?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(canonical.as_bytes());
    Ok(hasher.finalize().into())
}

pub(super) fn program_value(program: &Program) -> Value {
    let mut value = Map::new();
    value.insert("version".to_owned(), Value::from(1));
    value.insert(
        "interactions".to_owned(),
        Value::Array(
            program
                .interactions()
                .iter()
                .map(descriptor_value)
                .collect(),
        ),
    );
    value.insert(
        "programDigest".to_owned(),
        Value::String(program.digest().as_str().to_owned()),
    );
    Value::Object(value)
}

fn descriptor_value(descriptor: &InteractionDescriptor) -> Value {
    let mut value = Map::new();
    value.insert("version".to_owned(), Value::from(1));
    value.insert(
        "contract".to_owned(),
        descriptor.contract().identity_value(),
    );
    value.insert(
        "contractDigest".to_owned(),
        Value::String(descriptor.contract_digest().as_str().to_owned()),
    );
    let mut docs = Map::new();
    if let Some(summary) = descriptor.docs().summary() {
        docs.insert("summary".to_owned(), Value::String(summary.to_owned()));
    }
    if let Some(description) = descriptor.docs().description() {
        docs.insert(
            "description".to_owned(),
            Value::String(description.to_owned()),
        );
    }
    value.insert("docs".to_owned(), Value::Object(docs));
    value.insert(
        "annotations".to_owned(),
        Value::Object(descriptor.annotations().clone()),
    );
    Value::Object(value)
}
