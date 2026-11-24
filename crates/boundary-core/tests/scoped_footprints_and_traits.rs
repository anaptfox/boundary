//! Integration coverage for scoped footprints and algebraic contract traits.
#![allow(clippy::unwrap_used)]

use boundary_core::{
    InteractionContract, PortableSchema, ProgramErrorCode, contract_compatibility,
    footprint_subsumes, resolve_footprints,
};

fn contract(id: &str) -> InteractionContract {
    InteractionContract::builder(id, PortableSchema::any(), PortableSchema::any())
        .finish()
        .unwrap()
}

#[test]
fn scoped_templates_are_validated_and_directionally_compatible() {
    let valid =
        InteractionContract::builder("docs.read", PortableSchema::any(), PortableSchema::any())
            .reads([
                "documents",
                "document:{input.id}",
                "org:{input.org.id}:doc:{input.docId}",
            ])
            .finish();
    assert!(valid.is_ok());

    for invalid in [
        "",
        " documents",
        "documents ",
        "{}",
        "{id}",
        "{input.}",
        "{input.a..b}",
        "{input.a b}",
        "documents}",
        "{input.a",
    ] {
        let error =
            InteractionContract::builder("docs.read", PortableSchema::any(), PortableSchema::any())
                .reads([invalid])
                .finish()
                .unwrap_err();
        assert_eq!(
            error.code(),
            ProgramErrorCode::InvalidFootprint,
            "{invalid}"
        );
    }

    let expected =
        InteractionContract::builder("docs.read", PortableSchema::any(), PortableSchema::any())
            .reads(["documents:{input.id}"])
            .finish()
            .unwrap();
    let offered =
        InteractionContract::builder("docs.read", PortableSchema::any(), PortableSchema::any())
            .reads(["documents:doc-1"])
            .finish()
            .unwrap();
    assert!(contract_compatibility(&expected, &offered).is_compatible());
    let coarse =
        InteractionContract::builder("docs.read", PortableSchema::any(), PortableSchema::any())
            .reads(["documents"])
            .finish()
            .unwrap();
    assert!(!contract_compatibility(&offered, &coarse).is_compatible());
}

#[test]
fn matching_and_runtime_resolution_cover_nested_scalar_paths() {
    assert!(footprint_subsumes("documents", "documents:{input.id}"));
    assert!(footprint_subsumes(
        "documents:{input.id}",
        "documents:doc-1"
    ));
    assert!(!footprint_subsumes(
        "documents:doc-1",
        "documents:{input.id}"
    ));
    assert!(footprint_subsumes(
        "org:{input.org.id}:doc:{input.docId}",
        "org:acme:doc:99"
    ));

    let templates = vec![
        "org:{input.org.id}:doc:{input.docId}".to_owned(),
        "doc:{input.id}".to_owned(),
        "other:{input.missing}".to_owned(),
        "item:{input.bad}".to_owned(),
    ];
    let input = serde_json::json!({"org":{"id":"acme"},"docId":99,"id":12,"bad":[]});
    assert_eq!(
        resolve_footprints(&templates, &input),
        vec!["doc:12", "item", "org:acme:doc:99", "other"]
    );
}

#[test]
fn optional_traits_change_identity_and_are_directional() {
    let baseline = contract("docs.update");
    let absent_again = contract("docs.update");
    assert_eq!(baseline.digest().unwrap(), absent_again.digest().unwrap());

    let keyed =
        InteractionContract::builder("docs.update", PortableSchema::any(), PortableSchema::any())
            .idempotency_key("meta.requestId")
            .finish()
            .unwrap();
    assert_ne!(baseline.digest().unwrap(), keyed.digest().unwrap());
    assert_eq!(keyed.idempotency_key(), Some("meta.requestId"));
    let invalid_key =
        InteractionContract::builder("docs.update", PortableSchema::any(), PortableSchema::any())
            .idempotency_key("meta..key")
            .finish()
            .unwrap_err();
    assert_eq!(invalid_key.code(), ProgramErrorCode::InvalidTrait);

    let compensating =
        InteractionContract::builder("docs.update", PortableSchema::any(), PortableSchema::any())
            .compensates("docs.create")
            .finish()
            .unwrap();
    assert_ne!(baseline.digest().unwrap(), compensating.digest().unwrap());
    assert_eq!(
        compensating
            .compensates()
            .map(boundary_core::InteractionId::as_str),
        Some("docs.create")
    );
    assert!(
        InteractionContract::builder("docs.update", PortableSchema::any(), PortableSchema::any())
            .compensates("docs.update")
            .finish()
            .is_err()
    );
    assert!(!contract_compatibility(&keyed, &baseline).is_compatible());
    assert!(contract_compatibility(&baseline, &keyed).is_compatible());
    assert!(!contract_compatibility(&compensating, &baseline).is_compatible());
    assert!(contract_compatibility(&baseline, &compensating).is_compatible());

    let json = serde_json::to_string(&compensating).unwrap();
    let decoded: InteractionContract = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, compensating);
    assert!(json.contains("\"compensates\":\"docs.create\""));
    let keyed_json = serde_json::to_string(&keyed).unwrap();
    let keyed_decoded: InteractionContract = serde_json::from_str(&keyed_json).unwrap();
    assert_eq!(keyed_decoded.idempotency_key(), Some("meta.requestId"));
}
