//! End-to-end proof: a Zig component realizes an Boundary interaction.
//!
//! This is the whole thesis in one file. A plugin written in a language the
//! host knows nothing about realizes an interaction the host declared, reaches
//! exactly the host functions the host provided and nothing else, runs under a
//! budget it cannot exceed, and returns a domain result the host validates.
//!
//! The component is a build artifact, not a fixture, so these tests are
//! `#[ignore]` by default and run through `just wasm-guest-smoke`, which
//! builds the guest first. They require the Zig toolchain; see
//! `config/wasm-versions.json` for the pinned version.
#![allow(clippy::expect_used)]

use std::path::PathBuf;

use boundary_plugin::{
    GuestInstance, GuestLimits, GuestOutcome, HostFunctions, HostReply, PluginComponent,
    guest_engine,
};
use serde_json::{Value, json};

const WIT_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const INTERFACE: &str = "boundary:guest/footprints@1.0.0";
const EXPORT: &str = "images-make-thumbnail";

fn component_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm")
}

fn component_bytes() -> Vec<u8> {
    let path = component_path();
    // A missing artifact is a blocked prerequisite, not a pass. `expect` here
    // reports it with the command that builds it.
    std::fs::read(&path).expect(
        "the Zig guest component is missing; run `just wasm-guest-smoke`, which builds it first",
    )
}

/// The host side of the `images` footprint.
///
/// It answers with a decoded source image's dimensions. The guest never sees a
/// file, a byte of pixel data, or anything about the caller: decoding is the
/// host's job and the invocation context stays on the host.
fn images_host() -> HostFunctions {
    HostFunctions::new()
        .provide("images", |request| {
            HostReply::from_result((|| {
                let parsed: Value =
                    serde_json::from_str(request).map_err(|error| error.to_string())?;
                match parsed["imageId"].as_str() {
                    Some("original") => Ok(json!({"width": 800, "height": 600}).to_string()),
                    Some("tiny") => Ok(json!({"width": 50, "height": 20}).to_string()),
                    _ => Err(json!({"error": "not_found"}).to_string()),
                }
            })())
        })
        .expect("images is spellable")
}

// Share immutable compiled code, never a store, host map, or guest heap.
fn compiled() -> &'static (wasmtime::Engine, PluginComponent) {
    static COMPILED: std::sync::OnceLock<(wasmtime::Engine, PluginComponent)> =
        std::sync::OnceLock::new();
    COMPILED.get_or_init(|| {
        let engine = guest_engine().expect("engine");
        let bytes = component_bytes();
        let guest = PluginComponent::load(&engine, &bytes, WIT_DIGEST).expect("component loads");
        (engine, guest)
    })
}

fn instantiate(imports: &HostFunctions, limits: GuestLimits) -> GuestInstance {
    let (engine, guest) = compiled();
    GuestInstance::instantiate(engine, guest, imports, INTERFACE, limits).expect("instantiate")
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn the_zig_guest_realizes_the_interaction() {
    let mut instance = instantiate(&images_host(), GuestLimits::default());
    let outcome = instance.call(
        EXPORT,
        &json!({"imageId":"original","maxWidth":200}).to_string(),
    );

    let GuestOutcome::Returned(payload) = &outcome else {
        unreachable!("expected a returned value, got {outcome:?}")
    };
    let value: Value = serde_json::from_str(payload).expect("output is JSON");
    // 800x600 scaled to a 200 max width preserves the aspect ratio.
    assert_eq!(value["imageId"], "original");
    assert_eq!(value["width"], 200);
    assert_eq!(value["height"], 150);

    let again = instance.call(
        EXPORT,
        &json!({"imageId":"original","maxWidth":100}).to_string(),
    );
    let GuestOutcome::Returned(second) = &again else {
        unreachable!("reuse must succeed, got {again:?}")
    };
    let second: Value = serde_json::from_str(second).expect("output is JSON");
    assert_eq!(second["width"], 100);
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn the_guest_never_enlarges_a_source() {
    let mut instance = instantiate(&images_host(), GuestLimits::default());
    let outcome = instance.call(
        EXPORT,
        &json!({"imageId":"tiny","maxWidth":4000}).to_string(),
    );

    let GuestOutcome::Returned(payload) = &outcome else {
        unreachable!("expected a returned value, got {outcome:?}")
    };
    let value: Value = serde_json::from_str(payload).expect("output is JSON");
    assert_eq!(value["width"], 50, "a larger max width must not upscale");
    assert_eq!(value["height"], 20);
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn a_domain_failure_is_a_declared_error_not_a_fault() {
    let mut instance = instantiate(&images_host(), GuestLimits::default());
    let outcome = instance.call(
        EXPORT,
        &json!({"imageId":"missing","maxWidth":200}).to_string(),
    );

    // The host import refused. That is a domain outcome and must arrive as a
    // declared error, never as a trap and never as a success.
    assert!(
        matches!(outcome, GuestOutcome::DeclaredError(_)),
        "expected a declared error, got {outcome:?}"
    );
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn the_guest_imports_nothing_beyond_the_offer() {
    let (_, guest) = compiled();

    let required: Vec<String> = guest
        .required_imports()
        .iter()
        .map(boundary_plugin::RequiredImport::qualified)
        .collect();
    assert_eq!(
        required,
        vec!["boundary:guest/footprints@1.0.0#images".to_owned()],
        "a real guest must import exactly what the world provided, and no WASI"
    );
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn an_empty_offer_refuses_the_real_guest_too() {
    let (engine, guest) = compiled();

    let error = GuestInstance::instantiate(
        engine,
        guest,
        &HostFunctions::new(),
        INTERFACE,
        GuestLimits::default(),
    )
    .err()
    .expect("a guest provided nothing must not instantiate");

    assert!(
        error.to_string().contains("images"),
        "the refusal must name the import: {error}"
    );
}

#[test]
#[ignore = "requires the built Zig component; run `just wasm-guest-smoke`"]
fn the_guest_cannot_outrun_its_budget() {
    // One call of this guest costs about 1,400 fuel and startup costs about
    // 16,000, which is exactly why the two budgets are separate: a call budget
    // this tight would be impossible to express if startup shared it.
    //
    // A budget too small to finish must produce a fault, never a partial or
    // fabricated success. The consequence of a starved call is unknown.
    let mut instance = instantiate(
        &images_host(),
        GuestLimits {
            call_fuel: 500,
            ..GuestLimits::default()
        },
    );
    let outcome = instance.call(
        EXPORT,
        &json!({"imageId":"original","maxWidth":200}).to_string(),
    );
    assert!(
        outcome.is_fault(),
        "a starved call must be a fault, got {outcome:?}"
    );
}
