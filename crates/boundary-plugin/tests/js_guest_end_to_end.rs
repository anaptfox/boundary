//! End-to-end proof for the `jco` JavaScript guest.
//!
//! Same interaction and import map as the Zig guest. Bind identity is shared;
//! behavior is not claimed equivalent. The component embeds a JS engine; WASI
//! must still be absent from the import list.
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
        .join("../../examples/guests/thumbnail/javascript/thumbnail.component.wasm")
}

fn component_bytes() -> Vec<u8> {
    let path = component_path();
    std::fs::read(&path).expect(
        "the JavaScript guest component is missing; run `just wasm-js-guest`, which builds it first",
    )
}

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

#[test]
#[ignore = "requires the built JavaScript component; run `just wasm-js-guest`"]
fn the_js_guest_obeys_the_guest_laws() {
    let engine = guest_engine().expect("engine");
    let bytes = component_bytes();
    let guest = PluginComponent::load(&engine, &bytes, WIT_DIGEST).expect("component loads");
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

    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &images_host(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");
    let outcome = instance.call(
        EXPORT,
        &json!({"imageId":"original","maxWidth":200}).to_string(),
    );
    let GuestOutcome::Returned(payload) = &outcome else {
        unreachable!("expected a returned value, got {outcome:?}")
    };
    let value: Value = serde_json::from_str(payload).expect("output is JSON");
    assert_eq!(value["imageId"], "original");
    assert_eq!(value["width"], 200);
    assert_eq!(value["height"], 150);

    let denied = instance.call(
        EXPORT,
        &json!({"imageId":"missing","maxWidth":200}).to_string(),
    );
    assert!(
        matches!(denied, GuestOutcome::DeclaredError(_)),
        "expected a declared error, got {denied:?}"
    );
}
