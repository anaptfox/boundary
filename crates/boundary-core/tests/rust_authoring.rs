//! Rust types and Zod schemas author the same contract, byte for byte.
#![cfg(feature = "schemars")]
#![allow(dead_code, clippy::expect_used, clippy::panic)]

use std::{borrow::Cow, collections::BTreeMap, fmt::Write};

use boundary_core::{PortableSchema, canonical_json};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Parity {
    name: String,
    contract: Value,
    digest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclaredErrors {
    name: String,
    error_schema: Value,
    digest: String,
}
#[derive(Deserialize)]
struct Rejected {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    version: u8,
    patterns: BTreeMap<String, String>,
    parity: Vec<Parity>,
    declared_errors: Vec<DeclaredErrors>,
    rejected: Vec<Rejected>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/rust-authoring.json"
    ))
    .expect("reviewed Rust authoring vectors")
}

/// Stands in for `uuid::Uuid` without a dependency: the schema is exactly the
/// one schemars' `uuid1` feature emits (`{"type":"string","format":"uuid"}`).
struct Uuid;
impl JsonSchema for Uuid {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "Uuid".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({"type": "string", "format": "uuid"})
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Strict {
    id: String,
    count: u8,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Nullish {
    note: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
struct Catchall {
    x: u8,
    #[serde(flatten)]
    extra: BTreeMap<String, u8>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", deny_unknown_fields)]
enum Tagged {
    U,
    S { x: u8 },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
enum Untagged {
    N(u8),
    S(String),
    O { x: u8 },
}
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
struct Ids {
    id: Uuid,
    #[schemars(email)]
    e: String,
}

fn authored(name: &str) -> PortableSchema {
    match name {
        "strict-object" => PortableSchema::for_type::<Strict>(),
        "optional-nullable" => PortableSchema::for_type::<Nullish>(),
        "catchall" => PortableSchema::for_type::<Catchall>(),
        "tagged-union" => PortableSchema::for_type::<Tagged>(),
        "untagged-union" => PortableSchema::for_type::<Untagged>(),
        "uuid-email" => PortableSchema::for_type::<Ids>(),
        other => panic!("no Rust authoring for {other}"),
    }
    .expect("Schemars output lowers into the profile")
}

#[test]
fn rust_types_author_the_reviewed_contracts_and_digests() {
    let vectors = vectors();
    assert_eq!(vectors.version, 1);
    for vector in vectors.parity {
        let native = authored(&vector.name);
        let reviewed = PortableSchema::from_value(vector.contract).expect("reviewed contract");
        assert_eq!(native, reviewed, "{}", vector.name);
        let canonical = canonical_json(native.as_value()).expect("canonical contract");
        let hex =
            Sha256::digest(canonical.as_bytes())
                .iter()
                .fold(String::new(), |mut hex, byte| {
                    let _ = write!(hex, "{byte:02x}");
                    hex
                });
        let digest = format!("sha256:{hex}");
        assert_eq!(digest, vector.digest, "{}", vector.name);
    }
}

#[test]
fn schemars_formats_lower_to_the_pinned_zod_patterns() {
    let patterns = vectors().patterns;
    let schema = PortableSchema::for_type::<Ids>().expect("lowers");
    for (format, property) in [("uuid", "id"), ("email", "e")] {
        let found = schema
            .as_value()
            .pointer(&format!("/properties/{property}"))
            .and_then(|node| node.get("pattern"))
            .and_then(Value::as_str);
        assert_eq!(found, patterns.get(format).map(String::as_str), "{format}");
    }
}

#[derive(JsonSchema)]
struct OpenStruct {
    a: String,
}
#[derive(JsonSchema)]
#[serde(tag = "t")]
enum OpenEnum {
    S { x: u8 },
}
#[derive(JsonSchema)]
struct Inner {
    y: u8,
}
#[derive(JsonSchema)]
struct Flatten {
    x: u8,
    #[serde(flatten)]
    inner: Inner,
}

#[test]
fn open_shapes_are_refused() {
    for rejected in vectors().rejected {
        let outcome = match rejected.name.as_str() {
            "open-object" => PortableSchema::for_type::<OpenStruct>(),
            "open-enum-variant" => PortableSchema::for_type::<OpenEnum>(),
            "flatten-struct" => PortableSchema::for_type::<Flatten>(),
            other => panic!("no Rust authoring for {other}"),
        };
        let error = outcome.expect_err("open objects are not portable");
        assert!(
            error.to_string().contains("deny_unknown_fields"),
            "{}",
            rejected.name
        );
    }
}

#[test]
fn decode_judges_the_contract_before_serde() {
    use boundary_core::{JsonCodec, WireCodec};
    let ignored = serde_json::json!({"note": "n", "extra": 1});
    assert!(<JsonCodec<Nullish> as WireCodec<Nullish>>::decode(ignored).is_err());
    let fine = serde_json::json!({"note": null});
    assert!(<JsonCodec<Nullish> as WireCodec<Nullish>>::decode(fine).is_ok());
}

#[derive(Debug, thiserror::Error, Serialize, Deserialize, JsonSchema, boundary_core::Fault)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
enum ItemError {
    #[error("not found")]
    #[fault(code = "item_not_found")]
    #[serde(rename = "item_not_found")]
    NotFound { id: String },
    #[error("conflict")]
    #[fault(code = "item_conflict")]
    #[serde(rename = "item_conflict")]
    Conflict { expected: u8, actual: u8 },
    #[error("gone")]
    #[fault(code = "item_gone")]
    #[serde(rename = "item_gone")]
    Gone,
}

#[derive(Debug, thiserror::Error, Serialize, Deserialize, JsonSchema, boundary_core::Fault)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
enum OnlyGone {
    #[error("gone")]
    #[fault(code = "item_gone")]
    #[serde(rename = "item_gone")]
    Gone { id: String },
}

#[test]
fn fault_enums_declare_the_typescript_error_schema_and_digest() {
    use boundary_core::DeclaredErrorCodec;
    for vector in vectors().declared_errors {
        let native = match vector.name.as_str() {
            "payload-and-unit" => <boundary_core::JsonCodec<ItemError>>::declared_schema(),
            "single-code" => <boundary_core::JsonCodec<OnlyGone>>::declared_schema(),
            other => panic!("no Rust declared error for {other}"),
        }
        .expect("declared schema")
        .expect("declared errors");
        let reviewed = PortableSchema::from_value(vector.error_schema).expect("reviewed schema");
        assert_eq!(native, reviewed, "{}", vector.name);
        let canonical = canonical_json(native.as_value()).expect("canonical contract");
        let hex =
            Sha256::digest(canonical.as_bytes())
                .iter()
                .fold(String::new(), |mut hex, byte| {
                    let _ = write!(hex, "{byte:02x}");
                    hex
                });
        assert_eq!(format!("sha256:{hex}"), vector.digest, "{}", vector.name);
    }
}
