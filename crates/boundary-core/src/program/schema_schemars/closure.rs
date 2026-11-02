//! Authoring rules that keep a Schemars-derived contract equal to the one the
//! Zod adapter compiles: closed objects and pattern-only string formats.

use serde_json::{Map, Value};

use crate::program::{ProgramError, schema::schema_error};

/// The exact `pattern` Zod 4 emits for `z.uuid()`. The TypeScript adapter keeps
/// this pattern and drops `format`; `tests/conformance/v1/rust-authoring.json`
/// pins both tables to the same string.
const UUID_PATTERN: &str = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";

/// The exact `pattern` Zod 4 emits for `z.email()`.
const EMAIL_PATTERN: &str = "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

/// Replaces a `uuid` or `email` format with Zod's pattern. Returns whether the
/// format was one of these.
pub(super) fn lower_pattern_format(
    lowered: &mut Map<String, Value>,
    format: &str,
    path: &str,
) -> Result<bool, ProgramError> {
    let pattern = match format {
        "uuid" => UUID_PATTERN,
        "email" => EMAIL_PATTERN,
        _ => return Ok(false),
    };
    if lowered.get("type").is_some_and(|ty| ty != "string") {
        return Err(schema_error(
            path,
            format!("format {format} requires a string type"),
        ));
    }
    if lowered.contains_key("pattern") {
        return Err(schema_error(
            path,
            format!("format {format} cannot be combined with another pattern"),
        ));
    }
    lowered.remove("format");
    lowered.insert("pattern".into(), Value::String(pattern.to_owned()));
    Ok(true)
}

fn admits_object(lowered: &Map<String, Value>) -> bool {
    match lowered.get("type") {
        Some(Value::String(ty)) => ty == "object",
        Some(Value::Array(types)) => types.iter().any(|ty| ty == "object"),
        _ => lowered.contains_key("properties"),
    }
}

/// Rejects an object schema that does not say what happens to unknown keys.
/// Schemars omits `additionalProperties` unless the author closed the type, and
/// serde would silently ignore the extras the contract is meant to forbid.
pub(super) fn require_closed_object(
    lowered: &Map<String, Value>,
    path: &str,
) -> Result<(), ProgramError> {
    if admits_object(lowered) && !lowered.contains_key("additionalProperties") {
        return Err(schema_error(
            path,
            "open object: add #[serde(deny_unknown_fields)] to the struct or enum \
             (a #[serde(flatten)] struct cannot be closed; use a flattened BTreeMap catchall)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::lower_schemars;

    #[test]
    fn open_objects_are_refused_and_closed_ones_pass() {
        let open = json!({"type":"object","properties":{"a":{"type":"string"}}});
        assert!(lower_schemars(&open).is_err());
        let closed = json!({"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":false});
        assert!(lower_schemars(&closed).is_ok());
        let catchall = json!({"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":{"type":"integer"}});
        assert!(lower_schemars(&catchall).is_ok());
        let nested =
            json!({"oneOf":[{"type":"object","properties":{"t":{"const":"U"}},"required":["t"]}]});
        assert!(lower_schemars(&nested).is_err());
    }

    #[test]
    fn uuid_and_email_formats_become_patterns() {
        for format in ["uuid", "email"] {
            let lowered =
                lower_schemars(&json!({"type":"string","format":format})).unwrap_or_default();
            assert!(lowered.get("format").is_none(), "{format}");
            assert!(lowered["pattern"].is_string(), "{format}");
        }
        assert!(lower_schemars(&json!({"type":"string","format":"uuid","pattern":"x"})).is_err());
        assert!(lower_schemars(&json!({"type":"integer","format":"email"})).is_err());
    }
}
