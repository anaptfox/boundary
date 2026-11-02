//! Emits every WIT projection case as JSON so the reviewed conformance vector
//! can be checked against exact text. Run:
//! `cargo run -p boundary-plugin --example emit-vector-cases`.
#![allow(clippy::expect_used)]

use boundary_core::{InteractionContract, InteractionDescriptor, PortableSchema, Program};
use boundary_plugin::{WitProjectionError, WitProjectionOptions, project_wit};
use serde_json::{Value, json};

fn object() -> PortableSchema {
    PortableSchema::from_value(json!({"type":"object","additionalProperties":false}))
        .expect("schema")
}

fn contract(id: &str, reads: &[&str], changes: &[&str]) -> InteractionContract {
    InteractionContract::builder(id, object(), object())
        .reads(reads.iter().copied())
        .changes(changes.iter().copied())
        .finish()
        .expect("contract")
}

fn program(specs: &[(&str, &[&str], &[&str])]) -> Program {
    specs
        .iter()
        .fold(Program::builder(), |builder, (id, reads, changes)| {
            let descriptor = InteractionDescriptor::builder(contract(id, reads, changes))
                .finish()
                .expect("descriptor");
            builder.descriptor(descriptor).expect("accepted")
        })
        .finish()
        .expect("program")
}

fn case(name: &str, specs: &[(&str, &[&str], &[&str])]) -> Value {
    let source = program(specs);
    let interactions: Vec<Value> = specs
        .iter()
        .map(|(id, reads, changes)| {
            json!({
                "id": id,
                "reads": reads.to_vec(),
                "changes": changes.to_vec(),
            })
        })
        .collect();

    match project_wit(&source, &WitProjectionOptions::default()) {
        Ok(projection) => json!({
            "name": name,
            "interactions": interactions,
            "programDigest": projection.program_digest,
            "expected": {
                "status": "projected",
                "wit": projection.wit,
                "footprints": projection.footprints,
                "interactions": projection.interactions.iter().map(|interaction| json!({
                    "witName": interaction.wit_name,
                    "interactionId": interaction.interaction_id,
                    "contractDigest": interaction.contract_digest,
                })).collect::<Vec<_>>(),
            }
        }),
        Err(WitProjectionError::Collision {
            name: wit_name,
            interactions: ids,
        }) => json!({
            "name": name,
            "interactions": interactions,
            "expected": { "status": "collision", "witName": wit_name, "interactionIds": ids }
        }),
        Err(WitProjectionError::Names(errors)) => json!({
            "name": name,
            "interactions": interactions,
            "expected": {
                "status": "unspellable",
                "interactionIds": errors.iter().map(|error| error.interaction_id.clone()).collect::<Vec<_>>(),
            }
        }),
        Err(WitProjectionError::FootprintCollision {
            name: wit_name,
            footprints,
        }) => json!({
            "name": name,
            "interactions": interactions,
            "expected": {
                "status": "footprint-collision",
                "witName": wit_name,
                "footprints": footprints,
            }
        }),
        Err(other) => json!({ "name": name, "error": other.to_string() }),
    }
}

fn main() {
    let cases = json!([
        case(
            "shared-footprint",
            &[
                ("images.makeThumbnail", &["images"], &["images"]),
                ("images.inspect", &["images"], &[]),
            ]
        ),
        case("no-footprints", &[("math.add", &[], &[])]),
        case("collision", &[("a.bC", &[], &[]), ("a.b-c", &[], &[])]),
        case(
            "unspellable",
            &[("images.2x", &[], &[]), ("record", &[], &[])]
        ),
        case(
            "footprint-collision",
            &[("images.inspect", &["images.byId", "images.by-id"], &[])]
        ),
    ]);
    println!(
        "{}",
        serde_json::to_string_pretty(&cases).expect("serialize cases")
    );
}
