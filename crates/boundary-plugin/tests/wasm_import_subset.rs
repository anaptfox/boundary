//! Consumes the reviewed import-subset vector.
//!
//! The vector names fixture components and the exact refusal report. This
//! test never rewrites it. TypeScript consumes the same file.
#![allow(clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use boundary_plugin::{HostImports, ImportCheck, PluginComponent, PluginError, RequiredImport};
use serde_json::Value;
use wasmparser::component_types::ComponentEntityType;
use wasmparser::{Encoding, Parser, Payload, Validator};
use wasmtime::Engine;

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/wasm-import-subset.json"
    ))
    .expect("wasm-import-subset vector parses")
}

fn fixture_bytes(vector: &Value, name: &str) -> Vec<u8> {
    let relative = vector["fixtures"][name]
        .as_str()
        .unwrap_or_else(|| panic!("fixture {name} is listed"));
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .join(relative);
    fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|entry| entry.as_str().expect("string").to_owned())
        .collect()
}

fn validated_imports(bytes: &[u8]) -> Vec<RequiredImport> {
    // The validator resolves aliases, instantiation type substitutions and
    // export ascriptions. The parser only supplies root import names; neither
    // WAT nor the vector's expected names participates in this extraction.
    let types = Validator::default()
        .validate_all(bytes)
        .expect("fixture validates with wasmparser 0.258.3");
    let mut depth = 0;
    let mut required = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.expect("validated fixture parses") {
            Payload::Version { encoding, .. } => {
                if depth == 0 {
                    assert_eq!(encoding, Encoding::Component, "fixture is a component");
                }
                depth += 1;
            }
            Payload::End(_) => depth -= 1,
            Payload::ComponentImportSection(imports) if depth == 1 => {
                for import in imports {
                    let name = import.expect("validated import parses").name.name;
                    let item = types
                        .component_item_for_import(name)
                        .expect("root import has a resolved type");
                    match item.ty {
                        ComponentEntityType::Instance(instance) => {
                            // The portable check accounts for every member of
                            // an imported instance, including non-functions.
                            required.extend(types[instance].exports.keys().map(|member| {
                                RequiredImport {
                                    instance: Some(name.to_owned()),
                                    name: member.clone(),
                                }
                            }));
                        }
                        ComponentEntityType::Func(_) => required.push(RequiredImport {
                            instance: None,
                            name: name.to_owned(),
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    assert_eq!(depth, 0, "all nested components and modules ended");
    required.sort();
    required.dedup();
    required
}

fn check_validated_imports(required: &[RequiredImport], offer: &HostImports) -> ImportCheck {
    // Test-only subset oracle. The production check is available only on a
    // loaded PluginComponent, which Wasmtime cannot create for type-export
    // fixtures. Supported fixtures compare this result with production below.
    let mut used = BTreeSet::new();
    let mut unmapped = BTreeSet::new();
    for import in required {
        if import.instance.as_deref() == Some(offer.interface()) && offer.contains(&import.name) {
            used.insert(import.name.clone());
        } else {
            unmapped.insert(import.qualified());
        }
    }
    if unmapped.is_empty() {
        ImportCheck::Satisfied {
            used: used.into_iter().collect(),
        }
    } else {
        ImportCheck::Refused {
            unmapped: unmapped.into_iter().collect(),
            provided: offer.wit_names(),
        }
    }
}

fn observed(check: &ImportCheck, offer: &HostImports) -> Value {
    // The authority digest travels with the check because the two answer
    // different halves of one question: which bytes ran, and what they could
    // reach. A vector that pinned only the refusal report would let the
    // authority half drift between the two implementations unnoticed.
    let authority = offer.authority_digest();
    match check {
        ImportCheck::Satisfied { used } => serde_json::json!({
            "status": "satisfied",
            "used": used,
            "authorityDigest": authority,
        }),
        ImportCheck::Refused { unmapped, provided } => serde_json::json!({
            "status": "refused",
            "unmapped": unmapped,
            "provided": provided,
            "authorityDigest": authority,
        }),
    }
}

#[test]
fn every_reviewed_case_matches_the_binary_check() {
    let vector = vector();
    let engine = Engine::default();
    let default_interface = vector["interface"].as_str().expect("interface");
    let cases = vector["cases"].as_array().expect("cases");
    assert_ne!(cases.as_slice(), [] as [serde_json::Value; 0]);

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let bytes = fixture_bytes(&vector, case["component"].as_str().expect("component"));
        let required = validated_imports(&bytes);
        if case.get("required").is_some() {
            let mut qualified: Vec<_> = required.iter().map(RequiredImport::qualified).collect();
            qualified.sort();
            assert_eq!(qualified, strings(case, "required"), "imports for {name}");
        }
        let interface = case["interface"].as_str().unwrap_or(default_interface);
        let offer = strings(case, "provided")
            .into_iter()
            .fold(HostImports::new(interface), |offer, footprint| {
                offer.provide(footprint).expect("spellable")
            });
        let checked = check_validated_imports(&required, &offer);
        assert_eq!(
            observed(&checked, &offer),
            case["expected"],
            "validated imports for {name}"
        );
        if let Some(refusal) = case["rustLoadRefusal"].as_str() {
            let error = PluginComponent::load(&engine, &bytes, "sha256:00")
                .expect_err("runtime profile must refuse this otherwise valid component");
            assert!(
                matches!(error, PluginError::Load(_)),
                "case {name}: {error:?}"
            );
            let detail = wasmtime::component::Component::new(&engine, &bytes)
                .expect_err("Wasmtime independently refuses this fixture");
            let chain = format!("{detail:#}");
            assert!(chain.contains(refusal), "case {name}: {chain}");
            continue;
        }
        let guest = PluginComponent::load(&engine, &bytes, "sha256:00").unwrap_or_else(|error| {
            let detail = wasmtime::component::Component::new(&engine, &bytes).err();
            panic!("case {name} failed to load: {error:?}; validator: {detail:#?}")
        });
        assert_eq!(
            guest.required_imports(),
            required,
            "production imports for {name}"
        );
        assert_eq!(
            guest.check_imports(&offer),
            checked,
            "production check for {name}"
        );
        assert_eq!(
            observed(&guest.check_imports(&offer), &offer),
            case["expected"],
            "case {name}"
        );
    }
}
