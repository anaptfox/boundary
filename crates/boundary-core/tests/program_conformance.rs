//! Shared Program v1 compatibility vectors consumed by Rust and TypeScript.
#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use boundary_core::{
    InteractionContract, InteractionDescriptor, InteractionDocumentation, Program, canonical_json,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    version: u8,
    canonical: Vec<CanonicalVector>,
    contracts: Vec<ContractVector>,
    programs: Vec<ProgramVector>,
}

#[derive(Deserialize)]
struct CanonicalVector {
    name: String,
    value: Value,
    canonical: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractVector {
    name: String,
    contract: Value,
    identity_canonical: String,
    contract_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgramVector {
    name: String,
    contracts: Vec<String>,
    identity_canonical: String,
    program_digest: String,
}

#[test]
fn shared_v1_vectors_are_stable() {
    let vectors: Vectors =
        serde_json::from_str(include_str!("../../../tests/conformance/v1/program.json"))
            .expect("valid frozen vectors");
    assert_eq!(vectors.version, 1);

    for vector in &vectors.canonical {
        assert_eq!(
            canonical_json(&vector.value).expect("canonical JSON"),
            vector.canonical,
            "{}",
            vector.name
        );
    }

    let contracts: BTreeMap<_, _> = vectors
        .contracts
        .iter()
        .map(|vector| {
            let contract: InteractionContract =
                serde_json::from_value(vector.contract.clone()).expect("valid contract vector");
            assert_eq!(
                contract.digest().expect("contract digest").as_str(),
                vector.contract_digest
            );

            let identity_value: Value =
                serde_json::from_str(&vector.identity_canonical).expect("identity JSON");
            assert_eq!(
                canonical_json(&identity_value).expect("canonical identity"),
                vector.identity_canonical
            );
            (vector.name.clone(), contract)
        })
        .collect();

    for vector in &vectors.programs {
        let program = vector
            .contracts
            .iter()
            .fold(Program::builder(), |builder, name| {
                let contract = contracts.get(name).expect("known contract").clone();
                let descriptor = InteractionDescriptor::builder(contract)
                    .docs(InteractionDocumentation::new().with_summary("ignored"))
                    .annotations(serde_json::json!({"source": "rust-vector"}))
                    .finish()
                    .expect("descriptor");
                builder.descriptor(descriptor).expect("unique descriptor")
            })
            .finish()
            .expect("program");
        assert_eq!(
            program.digest().as_str(),
            vector.program_digest,
            "{}",
            vector.name
        );
        let identity_value: Value =
            serde_json::from_str(&vector.identity_canonical).expect("program identity JSON");
        assert_eq!(
            canonical_json(&identity_value).expect("canonical identity"),
            vector.identity_canonical
        );
    }
}
