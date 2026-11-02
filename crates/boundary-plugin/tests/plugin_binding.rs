// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! The host binds a plugin as one exact interaction realization.
//!
//! This is deliberately a test-only adapter. The application owns its Binding,
//! admission, and the decision to map a plugin fault to `Unknown`; the plugin
//! runtime does not install or admit interactions.
#![allow(clippy::expect_used)]

use std::fmt::Write;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use boundary_core::{
    ChangeFootprint, ChangesState, Interaction, JsonCodec, NoError, interaction_id,
    lifecycle::{
        BindResult, CallerError, InvocationCertainty, NativeDispatchFault, NativeDispatchRequest,
        NativeDispatcher, ProjectionModes, RealizationId, admit_all, bind, compile_interaction,
        dispatch_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use boundary_plugin::{
    GuestInstance, GuestLimits, GuestOutcome, HostFunctions, HostReply, PluginComponent,
    guest_engine,
};

const COMPONENT: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/compliant.component.wasm");
const WIT_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const INTERFACE: &str = "boundary:guest/footprints@1.0.0";
const EXPORT: &str = "images-make-thumbnail";

#[derive(Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MakeThumbnail {
    image_id: String,
    max_width: u64,
}

#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThumbnailOutput {
    image_id: String,
    width: u32,
    height: u32,
}

impl Interaction for MakeThumbnail {
    const ID: boundary_core::StaticInteractionId = interaction_id!("images.makeThumbnail");

    type Output = ThumbnailOutput;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<ThumbnailOutput>;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["images"], &["images"])
    }
}

struct ThumbnailPlugin {
    instance: Mutex<GuestInstance>,
    realization_id: RealizationId,
    dispatches: AtomicUsize,
}

impl NativeDispatcher<()> for ThumbnailPlugin {
    async fn dispatch(
        &self,
        request: NativeDispatchRequest<'_, ()>,
    ) -> Result<boundary_core::lifecycle::NativeDispatchOutcome, NativeDispatchFault> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        let encoded =
            serde_json::to_string(request.input()).map_err(|_| NativeDispatchFault::NotStarted)?;
        let mut instance = self
            .instance
            .lock()
            .map_err(|_| NativeDispatchFault::Unknown)?;
        match instance.call(EXPORT, &encoded) {
            GuestOutcome::Returned(payload) => {
                let output: Value =
                    serde_json::from_str(&payload).map_err(|_| NativeDispatchFault::Unknown)?;
                Ok(boundary_core::lifecycle::NativeDispatchOutcome::Returned(
                    output,
                ))
            }
            GuestOutcome::DeclaredError(_) => Err(NativeDispatchFault::Unknown),
            GuestOutcome::Fault { certainty, .. } => Err(match certainty {
                InvocationCertainty::NotStarted => NativeDispatchFault::NotStarted,
                InvocationCertainty::NotCompleted => NativeDispatchFault::NotCompleted,
                InvocationCertainty::Unknown | InvocationCertainty::Completed => {
                    NativeDispatchFault::Unknown
                }
            }),
        }
    }
}

fn plugin() -> ThumbnailPlugin {
    let engine = guest_engine().expect("engine");
    let component = PluginComponent::load(&engine, COMPONENT, WIT_DIGEST).expect("component");
    let imports = HostFunctions::new()
        .provide("images", |_| HostReply::Returned("{}".to_owned()))
        .expect("images is spellable");
    let instance = GuestInstance::instantiate(
        &engine,
        &component,
        &imports,
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("bind-time imports are satisfied");
    ThumbnailPlugin {
        instance: Mutex::new(instance),
        realization_id: RealizationId::new(component.realization_id()).expect("component identity"),
        dispatches: AtomicUsize::new(0),
    }
}

fn rust_plugin() -> ThumbnailPlugin {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../examples/guests/thumbnail/rust/target/wasm32-unknown-unknown/release/boundary_thumbnail_guest.wasm",
    );
    let bytes = std::fs::read(path).expect("run just wasm-rust-guest first");
    let engine = guest_engine().expect("engine");
    let wit = include_bytes!("../../../examples/guests/thumbnail/rust/wit/guest.wit");
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(wit) {
        write!(digest, "{byte:02x}").expect("writing to String");
    }
    let wit_digest = format!("sha256:{digest}");
    let component = PluginComponent::load(&engine, &bytes, &wit_digest).expect("component");
    let imports = HostFunctions::new()
        .provide("images", |_| {
            HostReply::Returned(r#"{"width":800,"height":600}"#.to_owned())
        })
        .expect("images is spellable");
    let instance = GuestInstance::instantiate(
        &engine,
        &component,
        &imports,
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("bind-time imports are satisfied");
    ThumbnailPlugin {
        instance: Mutex::new(instance),
        realization_id: RealizationId::new(component.realization_id()).expect("component identity"),
        dispatches: AtomicUsize::new(0),
    }
}

#[test]
fn a_bound_plugin_fault_stays_unknown_and_is_not_retried() {
    let interaction = compile_interaction::<MakeThumbnail>().expect("compile");
    let projection =
        project([select("make_thumbnail", &interaction, ProjectionModes::Direct).expect("select")])
            .expect("projection");
    let plugin = Arc::new(plugin());
    let installation = install(
        boundary_core::lifecycle::InstallationId::new("images/plugin/thumbnail/v1").expect("id"),
        [dispatch_realization(
            &interaction,
            plugin.realization_id.clone(),
            Arc::clone(&plugin),
        )],
    )
    .expect("installation");
    let bound = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(bound) => Some(bound),
        BindResult::Unrealized(_) => None,
    }
    .expect("plugin interaction must bind");
    let handle = projection
        .handles()
        .get("make_thumbnail", &interaction)
        .expect("handle");

    let result = block_on(bound.binding.caller().call(
        &(),
        &handle,
        MakeThumbnail {
            image_id: "original".to_owned(),
            max_width: 200,
        },
    ));
    assert!(matches!(result, Err(CallerError::Unknown)), "{result:?}");
    assert_eq!(plugin.dispatches.load(Ordering::SeqCst), 1);
}

#[test]
#[ignore = "requires the built Rust thumbnail component; run just wasm-rust-guest"]
fn a_built_rust_thumbnail_plugin_binds_and_returns_output() {
    let interaction = compile_interaction::<MakeThumbnail>().expect("compile");
    let projection =
        project([select("make_thumbnail", &interaction, ProjectionModes::Direct).expect("select")])
            .expect("projection");
    let plugin = Arc::new(rust_plugin());
    let installation = install(
        boundary_core::lifecycle::InstallationId::new("images/plugin/thumbnail/rust-v1")
            .expect("id"),
        [dispatch_realization(
            &interaction,
            plugin.realization_id.clone(),
            Arc::clone(&plugin),
        )],
    )
    .expect("installation");
    let bound = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(bound) => Some(bound),
        BindResult::Unrealized(_) => None,
    }
    .expect("plugin interaction must bind");
    let handle = projection
        .handles()
        .get("make_thumbnail", &interaction)
        .expect("handle");
    let output = block_on(bound.binding.caller().call(
        &(),
        &handle,
        MakeThumbnail {
            image_id: "original".to_owned(),
            max_width: 200,
        },
    ))
    .expect("plugin output");
    assert_eq!(
        output,
        ThumbnailOutput {
            image_id: "original".to_owned(),
            width: 200,
            height: 150
        }
    );
    assert_eq!(plugin.dispatches.load(Ordering::SeqCst), 1);
}
