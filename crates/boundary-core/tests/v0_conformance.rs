//! Cross-language conformance tests for checked-in version zero laws.
#![allow(clippy::expect_used)]

use boundary_core::{
    InteractionContract, PortableSchema, contract_compatibility, footprint_subsumes,
    resolve_footprints,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
struct Footprints {
    version: u8,
    valid: Vec<String>,
    invalid: Vec<String>,
    subsumption: Vec<Subsumption>,
    resolution: Vec<Resolution>,
}
#[derive(Deserialize)]
struct Subsumption {
    expected: String,
    offered: String,
    subsumes: bool,
}
#[derive(Deserialize)]
struct Resolution {
    templates: Vec<String>,
    input: Value,
    #[serde(rename = "expectedResolved")]
    expected: Vec<String>,
}

#[test]
fn checked_in_scoped_footprint_vectors_match_rust() {
    let vectors: Footprints = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/scoped-footprints.json"
    ))
    .expect("valid footprint vectors");
    assert_eq!(vectors.version, 1);
    for footprint in vectors.valid {
        assert!(
            InteractionContract::builder(
                "check.valid",
                PortableSchema::any(),
                PortableSchema::any()
            )
            .reads([footprint.clone()])
            .finish()
            .is_ok(),
            "valid: {footprint}"
        );
    }
    for footprint in vectors.invalid {
        assert!(
            InteractionContract::builder(
                "check.invalid",
                PortableSchema::any(),
                PortableSchema::any()
            )
            .reads([footprint.clone()])
            .finish()
            .is_err(),
            "invalid: {footprint}"
        );
    }
    for case in vectors.subsumption {
        assert_eq!(
            footprint_subsumes(&case.expected, &case.offered),
            case.subsumes,
            "{} covers {}",
            case.expected,
            case.offered
        );
    }
    for case in vectors.resolution {
        assert_eq!(
            resolve_footprints(&case.templates, &case.input),
            case.expected,
            "resolution for {:?}",
            case.templates
        );
    }
}

#[derive(Deserialize)]
struct Traits {
    version: u8,
    digests: Vec<DigestVector>,
    compatibility: Vec<CompatibilityVector>,
}
#[derive(Deserialize)]
struct DigestVector {
    name: String,
    contract: Value,
    canonical: String,
    digest: String,
}
#[derive(Deserialize)]
struct CompatibilityVector {
    name: String,
    compatible: bool,
    expected: Value,
    offered: Value,
}

#[test]
fn checked_in_contract_trait_vectors_match_rust() {
    let vectors: Traits = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/contract-traits.json"
    ))
    .expect("valid contract trait vectors");
    assert_eq!(vectors.version, 1);
    for vector in vectors.digests {
        let contract: InteractionContract =
            serde_json::from_value(vector.contract).expect("contract vector");
        assert_eq!(
            boundary_core::canonical_json(
                &serde_json::to_value(&contract).expect("serialize contract")
            )
            .expect("canonical contract"),
            vector.canonical,
            "{} canonical",
            vector.name
        );
        assert_eq!(
            contract.digest().expect("contract digest").as_str(),
            vector.digest,
            "{} digest",
            vector.name
        );
    }
    for vector in vectors.compatibility {
        let expected = trait_contract(&vector.expected);
        let offered = trait_contract(&vector.offered);
        let result = contract_compatibility(&expected, &offered);
        assert_eq!(
            result.is_compatible(),
            vector.compatible,
            "{}: {result:?}",
            vector.name
        );
    }
}

fn trait_contract(traits: &Value) -> InteractionContract {
    let mut contract = json!({"version":1,"id":"items.write","inputSchema":{"type":"object"},"outputSchema":{"type":"object"},"reads":[],"changes":[]});
    let target = contract.as_object_mut().expect("object contract");
    let fields: &Map<String, Value> = traits.as_object().expect("trait fields");
    target.extend(
        fields
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    serde_json::from_value(contract).expect("valid trait contract")
}
