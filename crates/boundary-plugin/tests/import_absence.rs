//! The absence test.
//!
//! A declared footprint is advisory for a native handler: nothing stops the
//! code from doing more than it declared. For a guest it is structural. The
//! host decides which functions exist, and a component asking for anything
//! else cannot be instantiated.
//!
//! Each check asserts the whole outcome value rather than one field, so a
//! refusal that stops naming what it refused is a failure here.
//!
//! These tests use real components built by `wasm-tools`; see
//! `tests/fixtures/wasm-imports/README.md` for the exact commands that
//! produced them.
#![allow(clippy::expect_used)]

use boundary_plugin::{HostImports, ImportCheck, PluginComponent, PluginError, PluginLifetime};
use wasmtime::Engine;

const COMPLIANT: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/compliant.component.wasm");
const OVERREACH: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/overreach.component.wasm");
const WASI: &[u8] = include_bytes!("../../../tests/fixtures/wasm-imports/wasi.component.wasm");

/// The WIT digest is an opaque pin in these tests; the projector supplies the
/// real one. It only has to be stable for identity to be stable.
const WIT_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

fn engine() -> Engine {
    Engine::default()
}

fn load(bytes: &[u8]) -> PluginComponent {
    PluginComponent::load(&engine(), bytes, WIT_DIGEST).expect("component loads")
}

fn providing(footprints: &[&str]) -> HostImports {
    footprints.iter().fold(
        HostImports::new("boundary:guest/footprints@1.0.0"),
        |offer, footprint| offer.provide(*footprint).expect("footprint is spellable"),
    )
}

fn names(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn actual_imports_are_read_from_the_binary() {
    let guest = load(COMPLIANT);
    let required: Vec<String> = guest
        .required_imports()
        .iter()
        .map(boundary_plugin::RequiredImport::qualified)
        .collect();
    assert_eq!(required, names(&["boundary:guest/footprints@1.0.0#images"]));
}

#[test]
fn a_guest_within_the_offer_binds() {
    let guest = load(COMPLIANT);
    assert_eq!(
        guest.check_imports(&providing(&["images"])),
        ImportCheck::Satisfied {
            used: names(&["images"])
        }
    );
}

#[test]
fn a_guest_reaching_past_the_offer_is_refused_before_it_runs() {
    let guest = load(OVERREACH);
    assert_eq!(
        guest.check_imports(&providing(&["images"])),
        ImportCheck::Refused {
            unmapped: names(&["boundary:guest/footprints@1.0.0#publications"]),
            provided: names(&["images"]),
        },
        "the refusal names the exact unprovided import and what was provided"
    );
}

#[test]
fn widening_the_offer_admits_the_same_guest() {
    let guest = load(OVERREACH);
    // Nothing about the component changed. The host's decision changed. That
    // is the whole point: authority lives in the host imports, not the declaration.
    assert_eq!(
        guest.check_imports(&providing(&["images", "publications"])),
        ImportCheck::Satisfied {
            used: names(&["images", "publications"])
        }
    );
}

#[test]
fn an_empty_offer_refuses_a_guest_that_imports_anything() {
    let guest = load(COMPLIANT);
    assert_eq!(
        guest.check_imports(&providing(&[])),
        ImportCheck::Refused {
            unmapped: names(&["boundary:guest/footprints@1.0.0#images"]),
            provided: Vec::new(),
        }
    );
}

#[test]
fn require_offered_returns_the_used_imports_when_satisfied() {
    let guest = load(COMPLIANT);
    assert_eq!(
        guest.require_provided(&providing(&["images"])),
        Ok(names(&["images"]))
    );
}

#[test]
fn require_offered_reports_an_actionable_error() {
    let guest = load(OVERREACH);
    assert_eq!(
        guest.require_provided(&providing(&["images"])),
        Err(PluginError::UnmappedImports {
            unmapped: names(&["boundary:guest/footprints@1.0.0#publications"]),
            provided: names(&["images"]),
        })
    );

    // The message a host operator reads must name both sides of the gap.
    let message = guest
        .require_provided(&providing(&["images"]))
        .expect_err("must refuse")
        .to_string();
    assert!(message.contains("publications"), "{message}");
    assert!(message.contains("Provided: images"), "{message}");
}

#[test]
fn wasi_is_withheld_by_construction_not_by_a_special_case() {
    let guest = load(WASI);
    // The host provides every Boundary footprint this guest could want. The guest
    // still cannot bind, because a clock is not something the host provided.
    // Nothing in the check mentions WASI; it is refused for the same reason
    // any unprovided import is refused.
    assert_eq!(
        guest.check_imports(&providing(&["images"])),
        ImportCheck::Refused {
            unmapped: names(&["wasi:clocks/wall-clock@0.2.0#now"]),
            provided: names(&["images"]),
        }
    );
}

#[test]
fn realization_identity_is_content_addressed() {
    let engine = engine();
    let first = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let again = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let other = PluginComponent::load(&engine, OVERREACH, WIT_DIGEST).expect("load");

    assert_eq!(
        first.realization_id(),
        again.realization_id(),
        "the same bytes against the same world are the same realization"
    );
    assert_ne!(
        first.realization_id(),
        other.realization_id(),
        "different guest bytes are never the same realization"
    );
    assert!(first.realization_id().starts_with("sha256:"));
    assert_eq!(first.component_digest().len(), "sha256:".len() + 64);

    // Whether guest heap state can outlive a call is part of what was bound,
    // so it enters the id; the bytes alone do not change.
    let persistent =
        PluginComponent::load_with(&engine, COMPLIANT, WIT_DIGEST, PluginLifetime::Persistent)
            .expect("load");
    assert_ne!(first.realization_id(), persistent.realization_id());
    assert_eq!(first.component_digest(), persistent.component_digest());
}

#[test]
fn the_world_a_guest_targets_participates_in_its_identity() {
    let engine = engine();
    let first = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let rebuilt_world = PluginComponent::load(
        &engine,
        COMPLIANT,
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    )
    .expect("load");
    assert_ne!(
        first.realization_id(),
        rebuilt_world.realization_id(),
        "the same bytes against a changed contract surface is a different realization"
    );
    assert_eq!(
        first.component_digest(),
        rebuilt_world.component_digest(),
        "the component digest is the bytes alone"
    );
}

#[test]
fn bytes_that_are_not_a_component_do_not_load() {
    let error = PluginComponent::load(&engine(), b"not a component", WIT_DIGEST)
        .expect_err("invalid bytes must not load");
    assert!(matches!(error, PluginError::Load(_)));
}
