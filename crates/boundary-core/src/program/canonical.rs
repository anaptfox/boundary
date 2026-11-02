use std::{collections::BTreeMap, fmt};

use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use super::{ProgramError, ProgramErrorCode};

/// Produces deterministic Program v1 JSON.
///
/// Object keys are ordered by UTF-8 bytes, numbers use ECMAScript formatting,
/// and negative zero is normalized to zero.
///
/// # Errors
///
/// Returns [`ProgramError`] when a number is non-finite or lies outside the
/// portable f64 number domain.
pub fn canonical_json(value: &Value) -> Result<String, ProgramError> {
    let mut output = String::new();
    write_value(value, "$", &mut output)?;
    Ok(output)
}

pub(super) fn hash_json(domain: &str, value: &Value) -> Result<[u8; 32], ProgramError> {
    if domain.trim().is_empty() || domain.contains('\0') {
        return Err(ProgramError::new(
            ProgramErrorCode::InvalidJson,
            "domain",
            "hash domain must be non-empty and contain no NUL byte",
        ));
    }
    let canonical = canonical_json(value)?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(canonical.as_bytes());
    Ok(hasher.finalize().into())
}

pub(super) fn normalize_value(value: Value) -> Result<Value, ProgramError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value),
        Value::Number(number) => normalize_number(&number).map(Value::Number),
        Value::Array(values) => values
            .into_iter()
            .map(normalize_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let mut normalized = serde_json::Map::new();
            for (key, child) in entries {
                normalized.insert(key, normalize_value(child)?);
            }
            Ok(Value::Object(normalized))
        }
    }
}

pub(super) fn parse_strict_json(source: &str) -> Result<Value, ProgramError> {
    let mut deserializer = serde_json::Deserializer::from_str(source);
    let value = StrictValue::deserialize(&mut deserializer)
        .map_err(|error| invalid_json("$", error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| invalid_json("$", error.to_string()))?;
    normalize_value(value.0)
}

fn write_value(value: &Value, path: &str, output: &mut String) -> Result<(), ProgramError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(true) => output.push_str("true"),
        Value::Bool(false) => output.push_str("false"),
        Value::String(value) => output.push_str(
            &serde_json::to_string(value).map_err(|error| invalid_json(path, error.to_string()))?,
        ),
        Value::Number(number) => output.push_str(&format_number(number, path)?),
        Value::Array(values) => {
            output.push('[');
            for (index, child) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(child, &format!("{path}[{index}]"), output)?;
            }
            output.push(']');
        }
        Value::Object(object) => {
            output.push('{');
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            for (index, (key, child)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|error| invalid_json(path, error.to_string()))?,
                );
                output.push(':');
                write_value(child, &format!("{path}.{key}"), output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn normalize_number(number: &Number) -> Result<Number, ProgramError> {
    let value = number
        .as_f64()
        .ok_or_else(|| invalid_json("$", "number is outside the portable f64 domain"))?;
    if !value.is_finite() {
        return Err(invalid_json("$", "JSON numbers must be finite"));
    }
    let normalized = if value == 0.0 { 0.0 } else { value };
    Number::from_f64(normalized).ok_or_else(|| invalid_json("$", "JSON numbers must be finite"))
}

fn format_number(number: &Number, path: &str) -> Result<String, ProgramError> {
    let value = number
        .as_f64()
        .ok_or_else(|| invalid_json(path, "number is outside the portable f64 domain"))?;
    if !value.is_finite() {
        return Err(invalid_json(path, "JSON numbers must be finite"));
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    let mut buffer = ryu_js::Buffer::new();
    Ok(buffer.format_finite(value).to_owned())
}

fn invalid_json(path: &str, message: impl Into<String>) -> ProgramError {
    ProgramError::new(ProgramErrorCode::InvalidJson, path, message)
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a finite JSON value without duplicate object keys")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let value = value.to_string().parse::<f64>().map_err(E::custom)?;
        self.visit_f64(value)
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let value = value.to_string().parse::<f64>().map_err(E::custom)?;
        self.visit_f64(value)
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if !value.is_finite() {
            return Err(E::custom("JSON numbers must be finite"));
        }
        let value = if value == 0.0 { 0.0 } else { value };
        Number::from_f64(value)
            .map(Value::Number)
            .map(StrictValue)
            .ok_or_else(|| E::custom("JSON numbers must be finite"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
            if values.insert(key.clone(), value.0).is_some() {
                return Err(serde::de::Error::custom(format!(
                    "duplicate object key `{key}`"
                )));
            }
        }
        Ok(StrictValue(Value::Object(values.into_iter().collect())))
    }
}
