//! WIT world projection: determinism, identity preservation, and exact refusal.
#![allow(clippy::expect_used)]

use boundary_core::{InteractionContract, InteractionDescriptor, PortableSchema, Program};
use boundary_plugin::{WitProjectionError, WitProjectionOptions, project_wit};
use serde_json::json;

fn schema(value: serde_json::Value) -> PortableSchema {
    PortableSchema::from_value(value).expect("portable schema")
}

fn object() -> PortableSchema {
    schema(json!({"type":"object","additionalProperties":false}))
}

fn contract(id: &str, reads: &[&str], changes: &[&str]) -> InteractionContract {
    InteractionContract::builder(id, object(), object())
        .reads(reads.iter().copied())
        .changes(changes.iter().copied())
        .finish()
        .expect("contract")
}

fn program(contracts: Vec<InteractionContract>) -> Program {
    contracts
        .into_iter()
        .fold(Program::builder(), |builder, contract| {
            let descriptor = InteractionDescriptor::builder(contract)
                .finish()
                .expect("descriptor");
            builder.descriptor(descriptor).expect("descriptor accepted")
        })
        .finish()
        .expect("program")
}

fn thumbnail_program() -> Program {
    program(vec![
        contract("images.makeThumbnail", &["images"], &["images"]),
        contract("images.inspect", &["images"], &[]),
    ])
}

#[test]
fn projection_is_byte_identical_across_runs() {
    let source = thumbnail_program();
    let options = WitProjectionOptions::default();
    let first = project_wit(&source, &options).expect("projection");
    let second = project_wit(&source, &options).expect("projection");
    assert_eq!(first.wit, second.wit);
}

#[test]
fn program_order_does_not_change_the_emitted_world() {
    let forward = program(vec![
        contract("images.makeThumbnail", &["images"], &["images"]),
        contract("images.inspect", &["images"], &[]),
    ]);
    let reverse = program(vec![
        contract("images.inspect", &["images"], &[]),
        contract("images.makeThumbnail", &["images"], &["images"]),
    ]);
    let options = WitProjectionOptions::default();
    assert_eq!(
        project_wit(&forward, &options).expect("forward").wit,
        project_wit(&reverse, &options).expect("reverse").wit
    );
}

#[test]
fn every_interaction_keeps_its_id_and_contract_digest() {
    let source = thumbnail_program();
    let projection = project_wit(&source, &WitProjectionOptions::default()).expect("projection");

    assert_eq!(projection.interactions.len(), 2);
    for interaction in &projection.interactions {
        let descriptor = source
            .interaction_named(&interaction.interaction_id)
            .expect("interaction present in the program");
        assert_eq!(
            interaction.contract_digest,
            descriptor.contract_digest().to_string(),
            "projection must pin the contract identity, not restate it"
        );
        assert!(projection.wit.contains(&interaction.interaction_id));
        assert!(projection.wit.contains(&interaction.contract_digest));
    }
    assert_eq!(projection.program_digest, source.digest().to_string());
}

#[test]
fn footprints_become_importable_names_exactly_once() {
    let source = thumbnail_program();
    let projection = project_wit(&source, &WitProjectionOptions::default()).expect("projection");
    // `images` appears in reads and changes across two interactions.
    assert_eq!(projection.footprints, vec!["images".to_owned()]);
    assert_eq!(projection.wit.matches("images: func").count(), 1);
}

#[test]
fn a_program_without_footprints_still_projects() {
    let source = program(vec![contract("math.add", &[], &[])]);
    let projection = project_wit(&source, &WitProjectionOptions::default()).expect("projection");
    assert_eq!(projection.footprints, [] as [String; 0]);
    assert!(projection.wit.contains("declares no reads or changes"));
}

#[test]
fn colliding_identifiers_refuse_rather_than_rename() {
    let source = program(vec![
        contract("a.bC", &[], &[]),
        contract("a.b-c", &[], &[]),
    ]);
    assert_eq!(
        project_wit(&source, &WitProjectionOptions::default()),
        Err(WitProjectionError::Collision {
            name: "a-b-c".to_owned(),
            interactions: vec!["a.b-c".to_owned(), "a.bC".to_owned()],
        })
    );
}

#[test]
fn unspellable_ids_are_reported_together() {
    let source = program(vec![
        contract("images.2x", &[], &[]),
        contract("record", &[], &[]),
    ]);
    let error =
        project_wit(&source, &WitProjectionOptions::default()).expect_err("both ids are invalid");
    // A wrong variant yields an empty list and fails the same assertion, so
    // there is no branch that can pass silently.
    let ids: Vec<&str> = match &error {
        WitProjectionError::Names(errors) => errors
            .iter()
            .map(|failure| failure.interaction_id.as_str())
            .collect(),
        _ => Vec::new(),
    };
    assert_eq!(
        ids,
        vec!["images.2x", "record"],
        "the report is exhaustive, not first-failure; got {error:?}"
    );
}

#[test]
fn the_world_never_grants_authority_it_only_names_it() {
    let source = thumbnail_program();
    let projection = project_wit(&source, &WitProjectionOptions::default()).expect("projection");
    // Imports are declared in an interface the host must still map at bind
    // time. The generated text says so, so a reader cannot mistake presence in
    // the world for a grant.
    assert!(projection.wit.contains("import footprints;"));
    assert!(projection.wit.contains("is not a"));
    assert!(projection.wit.contains("cannot be bound"));
}
