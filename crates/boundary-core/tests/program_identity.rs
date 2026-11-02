//! Program identity, availability, import, and compatibility behavior.
#![allow(clippy::expect_used)]

use boundary_core::{
    Compatibility, InteractionContract, InteractionDescriptor, InteractionDocumentation,
    PortableSchema, Program, ProgramErrorCode, contract_compatibility,
};
use serde_json::json;

fn schema(value: serde_json::Value) -> PortableSchema {
    PortableSchema::from_value(value).expect("portable schema")
}

fn contract(id: &str, reads: &[&str], changes: &[&str]) -> InteractionContract {
    InteractionContract::builder(
        id,
        schema(json!({"type":"object","additionalProperties":false})),
        schema(json!({"type":"object","additionalProperties":false})),
    )
    .reads(reads.iter().copied())
    .changes(changes.iter().copied())
    .finish()
    .expect("contract")
}

fn descriptor(contract: InteractionContract) -> InteractionDescriptor {
    InteractionDescriptor::builder(contract)
        .finish()
        .expect("descriptor")
}

#[test]
fn both_footprints_change_identity_but_docs_and_annotations_do_not() {
    let first = contract("todos.create", &["tenant", "todos"], &["todos"]);
    let different_reads = contract("todos.create", &["audit"], &["todos"]);
    let different_changes = contract("todos.create", &["tenant", "todos"], &["audit"]);
    assert_ne!(
        first.digest().expect("digest"),
        different_reads.digest().expect("digest")
    );
    assert_ne!(
        first.digest().expect("digest"),
        different_changes.digest().expect("digest")
    );

    let plain = InteractionDescriptor::builder(first.clone())
        .finish()
        .expect("plain");
    let decorated = InteractionDescriptor::builder(first)
        .docs(InteractionDocumentation::new().with_summary("Create one"))
        .annotations(json!({"ui":{"color":"green"}}))
        .finish()
        .expect("decorated");
    assert_eq!(plain.contract_digest(), decorated.contract_digest());

    let one = Program::builder()
        .descriptor(plain)
        .expect("plain")
        .finish()
        .expect("program");
    let two = Program::builder()
        .descriptor(decorated)
        .expect("decorated")
        .finish()
        .expect("program");
    assert_eq!(one.digest(), two.digest());
}

#[test]
fn program_order_is_deterministic_and_duplicate_ids_fail() {
    let create = descriptor(contract("todos.create", &[], &["todos"]));
    let list = descriptor(contract("todos.list", &["todos"], &[]));
    let forward = Program::builder()
        .descriptor(create.clone())
        .expect("create")
        .descriptor(list.clone())
        .expect("list")
        .finish()
        .expect("program");
    let reverse = Program::builder()
        .descriptor(list)
        .expect("list")
        .descriptor(create.clone())
        .expect("create")
        .finish()
        .expect("program");
    assert_eq!(forward, reverse);
    assert_eq!(
        forward.interactions()[0].contract().id().as_str(),
        "todos.create"
    );

    let duplicate = Program::builder()
        .descriptor(create.clone())
        .expect("first")
        .descriptor(create)
        .expect_err("duplicate must fail");
    assert_eq!(duplicate.code(), ProgramErrorCode::DuplicateInteraction);
}

#[test]
fn compatibility_is_directional_and_footprints_may_narrow() {
    let expected = InteractionContract::builder(
        "todos.create",
        schema(json!({
            "type":"object",
            "properties":{"title":{"type":"string"}},
            "required":["title"],
            "additionalProperties":false
        })),
        schema(json!({
            "type":"object",
            "properties":{"id":{"type":"string"}},
            "required":["id"],
            "additionalProperties":true
        })),
    )
    .reads(["old-read"])
    .changes(["todos"])
    .finish()
    .expect("expected");
    let offered = InteractionContract::builder(
        "todos.create",
        schema(json!({
            "type":"object",
            "properties":{"title":{}},
            "required":["title"],
            "additionalProperties":false
        })),
        schema(json!({
            "type":"object",
            "properties":{"id":{"type":"string","minLength":1},"serverOnly":{"type":"string"}},
            "required":["id","serverOnly"],
            "additionalProperties":false
        })),
    )
    .reads(["old-read"])
    .changes(["todos"])
    .finish()
    .expect("offered");
    assert_eq!(
        contract_compatibility(&expected, &offered),
        Compatibility::Compatible
    );
    assert!(!contract_compatibility(&offered, &expected).is_compatible());

    // A different read is a wider footprint, not a narrower one.
    let changed_reads = contract("todos.create", &["new-read"], &["todos"]);
    assert!(!contract_compatibility(&expected, &changed_reads).is_compatible());

    // A change the caller never budgeted for is refused.
    let changed = contract("todos.create", &[], &["audit"]);
    assert!(!contract_compatibility(&expected, &changed).is_compatible());

    // Touching strictly less than the caller expects can serve that caller.
    let wide = contract("todos.create", &["old-read", "clock"], &["todos"]);
    let narrow = contract("todos.create", &[], &["todos"]);
    assert_eq!(
        contract_compatibility(&wide, &narrow),
        Compatibility::Compatible
    );
    assert!(
        !contract_compatibility(&narrow, &wide).is_compatible(),
        "the direction matters: the wider footprint cannot serve the narrower caller"
    );
}

#[test]
fn strict_import_rejects_duplicates_and_digest_tampering() {
    let duplicate = PortableSchema::from_json_str(r#"{"type":"string","type":"number"}"#)
        .expect_err("duplicate keyword must fail");
    assert_eq!(duplicate.code(), ProgramErrorCode::InvalidJson);

    let program = Program::builder()
        .descriptor(descriptor(contract("todos.list", &[], &[])))
        .expect("descriptor")
        .finish()
        .expect("program");
    let mut encoded = serde_json::to_value(program).expect("serialize");
    encoded["programDigest"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let error = serde_json::from_value::<Program>(encoded).expect_err("tampering must fail");
    assert!(error.to_string().contains("program digest mismatch"));
}
