//! The `{ code, details }` declared-error form shared with TypeScript.
//!
//! A Serde adjacently tagged enum with `tag = "code", content = "details"` is
//! already that envelope. These helpers take it apart for the Handoff, which
//! carries `code` and `details` separately, and put it back together.

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use super::{PortableFault, WireCodec, WireError};
use crate::program::PortableSchema;

/// Returns the TypeScript-shaped contract schema for an envelope enum.
///
/// Every variant is a closed `{ code: { const }, details }` object. TypeScript
/// requires `details`, so a variant without content declares `null` details.
pub(super) fn declared_schema<E, C>() -> Result<Option<PortableSchema>, WireError>
where
    C: WireCodec<E>,
{
    let lowered = C::schema()?;
    let mut branches = match lowered.as_value() {
        Value::Object(object) if object.contains_key("oneOf") => match object.get("oneOf") {
            Some(Value::Array(branches)) => branches.clone(),
            _ => return Err(shape("oneOf must be an array")),
        },
        branch @ Value::Object(_) => vec![branch.clone()],
        _ => return Err(shape("schema must be an object")),
    };
    for branch in &mut branches {
        close_branch(branch)?;
    }
    // TypeScript declares errors in code order, and order is part of identity.
    branches.sort_by(|left, right| code_of(left).cmp(code_of(right)));
    let schema = if branches.len() == 1 {
        branches.remove(0)
    } else {
        json!({ "oneOf": branches })
    };
    PortableSchema::from_value(schema)
        .map(Some)
        .map_err(|error| WireError::Schema(error.to_string()))
}

fn code_of(branch: &Value) -> &str {
    branch["properties"]["code"]["const"]
        .as_str()
        .unwrap_or_default()
}

/// TypeScript's declared-error token rule: `[A-Za-z][A-Za-z0-9_-]{0,63}`.
fn is_token(code: &str) -> bool {
    let mut bytes = code.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && code.len() <= 64
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn close_branch(branch: &mut Value) -> Result<(), WireError> {
    let object = branch
        .as_object_mut()
        .ok_or_else(|| shape("each variant must be an object"))?;
    if object.get("additionalProperties") != Some(&Value::Bool(false)) {
        return Err(shape("add `deny_unknown_fields` to the enum"));
    }
    let properties = object
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| shape("each variant needs `code` and `details` properties"))?;
    if properties
        .keys()
        .any(|key| key != "code" && key != "details")
    {
        return Err(shape("variants may only declare `code` and `details`"));
    }
    let code = properties
        .get_mut("code")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| shape("each variant needs a `code` constant"))?;
    let Some(token) = code.get("const").and_then(Value::as_str) else {
        return Err(shape("each variant needs a string `code` constant"));
    };
    if !is_token(token) {
        return Err(shape(
            "codes must be stable ASCII tokens such as `item_not_found`",
        ));
    }
    // TypeScript declares the code as a bare `const`.
    code.remove("type");
    if !properties.contains_key("details") {
        properties.insert("details".to_owned(), json!({ "type": "null" }));
    }
    object.insert("required".to_owned(), json!(["code", "details"]));
    Ok(())
}

fn shape(message: &str) -> WireError {
    WireError::Schema(format!(
        "an adjacently tagged error must be `tag = \"code\", content = \"details\"`: {message}"
    ))
}

/// Encodes the `details` of an envelope error; a variant without content has
/// `null` details.
pub(super) fn encode<E: PortableFault + Serialize>(error: &E) -> Result<Value, WireError> {
    let Value::Object(mut object) =
        serde_json::to_value(error).map_err(|error| WireError::Encode(error.to_string()))?
    else {
        return Err(WireError::Encode(
            "error is not a code/details object".to_owned(),
        ));
    };
    let details = object.remove("details").unwrap_or(Value::Null);
    if object.len() != 1 || !object.contains_key("code") {
        return Err(WireError::Encode("error has unexpected members".to_owned()));
    }
    Ok(details)
}

/// Verifies that the serialized tag is the error's public fault code.
pub(super) fn check_code<E: PortableFault + Serialize>(error: &E) -> Result<(), WireError> {
    let value =
        serde_json::to_value(error).map_err(|error| WireError::Encode(error.to_string()))?;
    if value.get("code").and_then(Value::as_str) == Some(error.code()) {
        Ok(())
    } else {
        Err(WireError::Encode(
            "the serde tag must equal the fault code; add `#[serde(rename = \"<code>\")]`"
                .to_owned(),
        ))
    }
}

/// Reassembles an envelope error from its Handoff `code` and `details`.
pub(super) fn decode<E, C>(code: &str, details: Value) -> Result<E, WireError>
where
    E: DeserializeOwned,
    C: WireCodec<E>,
{
    let mut full = Map::new();
    full.insert("code".to_owned(), Value::String(code.to_owned()));
    let bare = details.is_null().then(|| full.clone());
    full.insert("details".to_owned(), details);
    match (C::decode(Value::Object(full)), bare) {
        // A variant without content serializes no `details` member at all.
        (Err(_), Some(bare)) => C::decode(Value::Object(bare)),
        (result, _) => result,
    }
}
