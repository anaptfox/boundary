// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Native implementation of the reviewed restriction laws and revocation races.

use boundary_core::{
    Handler, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly, interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, BindingManifest, Bound,
        CallerError, InstallationId, ProjectionModes, RealizationId, RequestCapability,
        RequestCapabilityFault, RequestControlDigest, RequestIdentity, UnrealizedReason, admit_all,
        bind, compile_interaction, direct_realization, identified_request_realization, install,
        project, restrict_binding, select,
    },
};
use futures::{channel::oneshot, executor::block_on, task::noop_waker_ref};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    error::Error,
    future::Future,
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context as TaskContext, Poll},
};

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Read {
    value: String,
}

impl Interaction for Read {
    const ID: boundary_core::StaticInteractionId = interaction_id!("restriction.get");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["documents"])
    }
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Other {
    value: String,
}

impl Interaction for Other {
    const ID: boundary_core::StaticInteractionId = interaction_id!("restriction.other");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["documents"])
    }
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Changed {
    value: String,
}

impl Interaction for Changed {
    const ID: boundary_core::StaticInteractionId = interaction_id!("restriction.get");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["different"])
    }
}

#[derive(Default)]
struct AppContext {
    dispatches: AtomicUsize,
}

struct ReadHandler;
impl Handler<Read, AppContext> for ReadHandler {
    async fn handle(&self, context: &AppContext, input: Read) -> Result<String, NoError> {
        context.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(input.value)
    }
}

struct ReadRequest;
impl RequestCapability<Read, AppContext> for ReadRequest {
    async fn request<'a>(
        &'a self,
        _context: &'a AppContext,
        input: Read,
    ) -> Result<Value, RequestCapabilityFault> {
        Ok(Value::String(input.value))
    }
}

struct OtherHandler;
impl Handler<Other, AppContext> for OtherHandler {
    async fn handle(&self, context: &AppContext, input: Other) -> Result<String, NoError> {
        context.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(input.value)
    }
}

type Calls = Arc<Mutex<Vec<(String, String, usize, usize)>>>;
struct RecordingAdmission {
    name: &'static str,
    allow: bool,
    calls: Calls,
}
impl Admission<AppContext> for RecordingAdmission {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, AppContext>) -> AdmissionDecision {
        let input = request
            .native_input::<Read>()
            .map_or(0, |value| std::ptr::from_ref(value).addr());
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((
                self.name.to_owned(),
                request.interaction().alias().to_owned(),
                input,
                std::ptr::from_ref(request.context()).addr(),
            ));
        if self.allow {
            AdmissionDecision::Admit
        } else {
            AdmissionDecision::Deny {
                code: "vector-denial".to_owned(),
            }
        }
    }
}

fn bound<C: Sync + ?Sized, A>(
    result: BindResult<C, A>,
) -> Result<Box<Bound<C, A>>, Box<dyn Error>> {
    match result {
        BindResult::Bound(bound) => Ok(bound),
        BindResult::Unrealized(report) => {
            Err(format!("unexpected unrealized: {:?}", report.issues()).into())
        }
    }
}

fn law() -> Result<Value, serde_json::Error> {
    serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/binding-restriction.json"
    ))
}

#[test]
fn reviewed_admission_laws_keep_exact_native_input_and_corresponding_views()
-> Result<(), Box<dyn Error>> {
    let law = law()?;
    assert_eq!(law["version"], 1);
    for row in law["admission"]
        .as_array()
        .ok_or("missing admission laws")?
    {
        let read = compile_interaction::<Read>()?;
        let parent_projection = project([select("get", &read, ProjectionModes::Direct)?])?;
        let child_projection = project([select("renamed", &read, ProjectionModes::Direct)?])?;
        let installation = install(
            InstallationId::new("restriction:installation")?,
            [direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            )],
        )?;
        let calls: Calls = Arc::default();
        let parent = bound(bind(
            &parent_projection,
            &installation.installation,
            RecordingAdmission {
                name: "parent",
                allow: row["parent"] == "allow",
                calls: Arc::clone(&calls),
            },
        ))?;
        let child = bound(restrict_binding(
            &parent.binding,
            &child_projection,
            RecordingAdmission {
                name: "additional",
                allow: row["additional"] == "allow",
                calls: Arc::clone(&calls),
            },
        ))?;
        let handle = child_projection.handles().get("renamed", &read)?;
        let context = AppContext::default();
        let result = block_on(child.binding.caller().call(
            &context,
            &handle,
            Read {
                value: "vector".to_owned(),
            },
        ));
        let actual = calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(
            serde_json::to_value(actual.iter().map(|row| &row.0).collect::<Vec<_>>())?,
            row["calls"]
        );
        assert_eq!(
            context.dispatches.load(Ordering::SeqCst) as u64,
            row["dispatches"]
        );
        assert_eq!(result.is_ok(), row["dispatches"] == 1);
        assert_eq!(actual[0].1, "get");
        if actual.len() == 2 {
            assert_eq!(actual[1].1, "renamed");
            assert_ne!(actual[0].2, 0);
            assert_eq!(actual[0].2, actual[1].2);
            assert_eq!(actual[0].3, actual[1].3);
        }
        assert_eq!(
            child.binding.manifest().installation_id(),
            parent.binding.manifest().installation_id()
        );
        assert_eq!(
            child.binding.manifest().interactions()[0].realization_id(),
            parent.binding.manifest().interactions()[0].realization_id()
        );
    }
    Ok(())
}

#[test]
fn reviewed_subset_laws_are_atomic_and_keep_policy_outside_identity() -> Result<(), Box<dyn Error>>
{
    let law = law()?;
    let read = compile_interaction::<Read>()?;
    let other = compile_interaction::<Other>()?;
    let changed = compile_interaction::<Changed>()?;
    let parent_projection = project([select("get", &read, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("restriction:installation")?,
        [
            direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            ),
            direct_realization(
                &other,
                RealizationId::new("restriction:other:direct")?,
                OtherHandler,
            ),
        ],
    )?;
    let parent = bound(bind(
        &parent_projection,
        &installation.installation,
        admit_all(),
    ))?;
    for row in law["subset"].as_array().ok_or("missing subset laws")? {
        let projection = match row["difference"].as_str().ok_or("missing difference")? {
            "none" => project([select("get", &read, ProjectionModes::Direct)?])?,
            "alias" => project([select("renamed", &read, ProjectionModes::Direct)?])?,
            "empty" => project([])?,
            "interaction" => project([select("other", &other, ProjectionModes::Direct)?])?,
            "contract" => project([select("get", &changed, ProjectionModes::Direct)?])?,
            "mode" => project([select("get", &read, ProjectionModes::Request)?])?,
            other => return Err(format!("unsupported reviewed difference {other}").into()),
        };
        match restrict_binding(&parent.binding, &projection, admit_all()) {
            BindResult::Bound(child) => {
                assert_eq!(row["status"], "bound");
                if row["difference"] == "none" {
                    assert_eq!(
                        child.binding.manifest().binding_digest(),
                        parent.binding.manifest().binding_digest()
                    );
                }
                let restored: BindingManifest =
                    serde_json::from_value(serde_json::to_value(child.binding.manifest())?)?;
                assert_eq!(&restored, child.binding.manifest());
            }
            BindResult::Unrealized(report) => {
                assert_eq!(row["status"], "unrealized");
                assert_eq!(report.issues().len(), 1);
                assert_eq!(
                    serde_json::to_value(report.issues()[0].reason())?,
                    row["reason"]
                );
                let restored: boundary_core::lifecycle::UnrealizedReport =
                    serde_json::from_value(serde_json::to_value(report)?)?;
                assert_eq!(restored.issues().len(), 1);
            }
        }
    }
    Ok(())
}

#[test]
fn nested_admission_and_revocation_follow_private_lineage() -> Result<(), Box<dyn Error>> {
    let read = compile_interaction::<Read>()?;
    let projection = project([select("get", &read, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("restriction:installation")?,
        [direct_realization(
            &read,
            RealizationId::new("restriction:get:direct")?,
            ReadHandler,
        )],
    )?;
    let calls: Calls = Arc::default();
    let admission = |name| RecordingAdmission {
        name,
        allow: true,
        calls: Arc::clone(&calls),
    };
    let parent = bound(bind(
        &projection,
        &installation.installation,
        admission("parent"),
    ))?;
    let child = bound(restrict_binding(
        &parent.binding,
        &projection,
        admission("child"),
    ))?;
    let grandchild = bound(restrict_binding(
        &child.binding,
        &projection,
        admission("grandchild"),
    ))?;
    let sibling = bound(restrict_binding(&parent.binding, &projection, admit_all()))?;
    let context = AppContext::default();
    let handle = projection.handles().get("get", &read)?;
    block_on(grandchild.binding.caller().call(
        &context,
        &handle,
        Read {
            value: "three".to_owned(),
        },
    ))?;
    assert_eq!(
        calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|row| row.0.as_str())
            .collect::<Vec<_>>(),
        ["parent", "child", "grandchild"]
    );
    assert!(child.controller.revoke());
    assert!(!child.controller.revoke());
    assert!(matches!(
        block_on(grandchild.binding.caller().call(
            &context,
            &handle,
            Read {
                value: "no".to_owned()
            }
        )),
        Err(CallerError::Revoked)
    ));
    block_on(parent.binding.caller().call(
        &context,
        &handle,
        Read {
            value: "parent".to_owned(),
        },
    ))?;
    block_on(sibling.binding.caller().call(
        &context,
        &handle,
        Read {
            value: "sibling".to_owned(),
        },
    ))?;
    assert!(parent.controller.revoke());
    assert!(matches!(
        block_on(sibling.binding.caller().call(
            &context,
            &handle,
            Read {
                value: "no".to_owned()
            }
        )),
        Err(CallerError::Revoked)
    ));
    match restrict_binding(&parent.binding, &projection, admit_all()) {
        BindResult::Unrealized(report) => assert_eq!(
            report.issues()[0].reason(),
            UnrealizedReason::BindingRevoked
        ),
        BindResult::Bound(_) => return Err("revoked parent created a live child".into()),
    }
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 3);
    Ok(())
}

struct SuspendedAdmission {
    resume: Mutex<Option<oneshot::Receiver<()>>>,
}
impl Admission<AppContext> for SuspendedAdmission {
    async fn admit<'a>(&'a self, _request: AdmissionRequest<'a, AppContext>) -> AdmissionDecision {
        let receiver = self
            .resume
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(receiver) = receiver {
            let _ = receiver.await;
        }
        AdmissionDecision::Admit
    }
}

#[test]
fn parent_and_installation_revocation_during_await_prevent_dispatch() -> Result<(), Box<dyn Error>>
{
    for revoke_installation in [false, true] {
        let read = compile_interaction::<Read>()?;
        let projection = project([select("get", &read, ProjectionModes::Direct)?])?;
        let installation = install(
            InstallationId::new("restriction:installation")?,
            [direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            )],
        )?;
        let parent = bound(bind(&projection, &installation.installation, admit_all()))?;
        let (send, receive) = oneshot::channel();
        let child = bound(restrict_binding(
            &parent.binding,
            &projection,
            SuspendedAdmission {
                resume: Mutex::new(Some(receive)),
            },
        ))?;
        let handle = projection.handles().get("get", &read)?;
        let context = AppContext::default();
        let caller = child.binding.caller();
        let mut future = pin!(caller.call(
            &context,
            &handle,
            Read {
                value: "never".to_owned()
            }
        ));
        assert!(matches!(
            future
                .as_mut()
                .poll(&mut TaskContext::from_waker(noop_waker_ref())),
            Poll::Pending
        ));
        if revoke_installation {
            assert!(installation.controller.revoke());
        } else {
            assert!(parent.controller.revoke());
        }
        let _ = send.send(());
        assert!(matches!(block_on(future), Err(CallerError::Revoked)));
        assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    }
    Ok(())
}

#[test]
fn request_only_restriction_keeps_exact_control_pins_and_admission_views()
-> Result<(), Box<dyn Error>> {
    let read = compile_interaction::<Read>()?;
    let parent_projection = project([select("get", &read, ProjectionModes::DirectAndRequest)?])?;
    let requests = project([select("request", &read, ProjectionModes::Request)?])?;
    let control = RequestControlDigest::parse(format!("sha256:{}", "2".repeat(64)))?;
    let installation = install(
        InstallationId::new("restriction:installation")?,
        [
            direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            ),
            identified_request_realization(
                &read,
                RealizationId::new("restriction:get:request")?,
                RequestIdentity::new(
                    control.clone(),
                    boundary_core::PortableSchema::of_type(boundary_core::SchemaType::String),
                ),
                ReadRequest,
            ),
        ],
    )?;
    let calls: Calls = Arc::default();
    let parent = bound(bind(
        &parent_projection,
        &installation.installation,
        RecordingAdmission {
            name: "parent",
            allow: true,
            calls: Arc::clone(&calls),
        },
    ))?;
    let child = bound(restrict_binding(
        &parent.binding,
        &requests,
        RecordingAdmission {
            name: "child",
            allow: true,
            calls: Arc::clone(&calls),
        },
    ))?;
    let handle = requests.handles().get("request", &read)?;
    let context = AppContext::default();
    assert_eq!(
        block_on(child.binding.caller().request(
            &context,
            &handle,
            Read {
                value: "preview".to_owned()
            }
        ))?,
        Value::String("preview".to_owned())
    );
    assert!(matches!(
        block_on(child.binding.caller().call(
            &context,
            &handle,
            Read {
                value: "never".to_owned()
            }
        )),
        Err(CallerError::ModeNotSelected)
    ));
    let actual = calls
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(
        actual.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        ["parent", "child"]
    );
    assert_eq!(actual[0].1, "get");
    assert_eq!(actual[1].1, "request");
    assert_eq!(
        child.binding.manifest().interactions()[0]
            .request_identity()
            .ok_or("lost request identity")?
            .control_digest(),
        &control
    );
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn revocation_during_inherited_admission_skips_additional_policy() -> Result<(), Box<dyn Error>> {
    for target in ["parent", "installation", "child"] {
        let read = compile_interaction::<Read>()?;
        let projection = project([select("get", &read, ProjectionModes::Direct)?])?;
        let installation = install(
            InstallationId::new("restriction:installation")?,
            [direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            )],
        )?;
        let (send, receive) = oneshot::channel();
        let parent = bound(bind(
            &projection,
            &installation.installation,
            SuspendedAdmission {
                resume: Mutex::new(Some(receive)),
            },
        ))?;
        let calls: Calls = Arc::default();
        let child = bound(restrict_binding(
            &parent.binding,
            &projection,
            RecordingAdmission {
                name: "additional",
                allow: true,
                calls: Arc::clone(&calls),
            },
        ))?;
        let handle = projection.handles().get("get", &read)?;
        let context = AppContext::default();
        let caller = child.binding.caller();
        let mut future = pin!(caller.call(
            &context,
            &handle,
            Read {
                value: "never".to_owned()
            }
        ));
        assert!(matches!(
            future
                .as_mut()
                .poll(&mut TaskContext::from_waker(noop_waker_ref())),
            Poll::Pending
        ));
        match target {
            "parent" => assert!(parent.controller.revoke()),
            "installation" => assert!(installation.controller.revoke()),
            "child" => assert!(child.controller.revoke()),
            _ => return Err("unknown revocation target".into()),
        }
        let _ = send.send(());
        assert!(matches!(block_on(future), Err(CallerError::Revoked)));
        assert!(
            calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        );
        assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    }
    Ok(())
}

#[test]
fn grandchild_revocation_during_root_admission_skips_every_remaining_policy()
-> Result<(), Box<dyn Error>> {
    let read = compile_interaction::<Read>()?;
    let projection = project([select("get", &read, ProjectionModes::Direct)?])?;
    let installation = install(
        InstallationId::new("restriction:nested-installation")?,
        [direct_realization(
            &read,
            RealizationId::new("restriction:nested-direct")?,
            ReadHandler,
        )],
    )?;
    let (send, receive) = oneshot::channel();
    let root = bound(bind(
        &projection,
        &installation.installation,
        SuspendedAdmission {
            resume: Mutex::new(Some(receive)),
        },
    ))?;
    let calls: Calls = Arc::default();
    let child = bound(restrict_binding(
        &root.binding,
        &projection,
        RecordingAdmission {
            name: "child",
            allow: true,
            calls: Arc::clone(&calls),
        },
    ))?;
    let grandchild = bound(restrict_binding(
        &child.binding,
        &projection,
        RecordingAdmission {
            name: "grandchild",
            allow: true,
            calls: Arc::clone(&calls),
        },
    ))?;
    let handle = projection.handles().get("get", &read)?;
    let context = AppContext::default();
    let caller = grandchild.binding.caller();
    let mut future = pin!(caller.call(
        &context,
        &handle,
        Read {
            value: "never".to_owned()
        }
    ));
    assert!(matches!(
        future
            .as_mut()
            .poll(&mut TaskContext::from_waker(noop_waker_ref())),
        Poll::Pending
    ));
    assert!(grandchild.controller.revoke());
    let _ = send.send(());
    assert!(matches!(block_on(future), Err(CallerError::Revoked)));
    assert!(
        calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn reviewed_empty_selection_refusal_preserves_global_revocation() -> Result<(), Box<dyn Error>> {
    let law = law()?;
    for target in ["parent", "installation"] {
        let read = compile_interaction::<Read>()?;
        let projection = project([select("get", &read, ProjectionModes::Direct)?])?;
        let empty = project([])?;
        let installation = install(
            InstallationId::new("restriction:installation")?,
            [direct_realization(
                &read,
                RealizationId::new("restriction:get:direct")?,
                ReadHandler,
            )],
        )?;
        let parent = bound(bind(&projection, &installation.installation, admit_all()))?;
        if target == "parent" {
            assert!(parent.controller.revoke());
        } else {
            assert!(installation.controller.revoke());
        }
        match restrict_binding(&parent.binding, &empty, admit_all()) {
            BindResult::Unrealized(report) => {
                let field = if target == "parent" {
                    "revokedParentRefusesEmptySelection"
                } else {
                    "revokedInstallationRefusesEmptySelection"
                };
                assert_eq!(law["revocation"][field], true);
                assert_eq!(report.issues(), []);
                let restored: boundary_core::lifecycle::UnrealizedReport =
                    serde_json::from_value(serde_json::to_value(report)?)?;
                assert_eq!(restored.projection().interactions(), []);
                assert_eq!(restored.issues(), []);
            }
            BindResult::Bound(_) => return Err("revoked lineage created a live empty child".into()),
        }
    }
    Ok(())
}

#[test]
fn reviewed_empty_root_binding_requires_a_live_installation() -> Result<(), Box<dyn Error>> {
    let law = law()?;
    let empty = project([])?;
    let installed = install::<AppContext>(InstallationId::new("restriction:empty-root")?, [])?;
    assert!(matches!(
        bind(&empty, &installed.installation, admit_all()),
        BindResult::Bound(_)
    ));
    assert!(installed.controller.revoke());
    match bind(&empty, &installed.installation, admit_all()) {
        BindResult::Unrealized(report) => {
            assert_eq!(
                law["revocation"]["revokedInstallationRefusesEmptyRootBinding"],
                true
            );
            assert_eq!(report.issues(), []);
            let restored: boundary_core::lifecycle::UnrealizedReport =
                serde_json::from_value(serde_json::to_value(report)?)?;
            assert_eq!(restored.issues(), []);
            assert_eq!(restored.projection().interactions(), []);
        }
        BindResult::Bound(_) => {
            return Err("revoked installation created an empty root binding".into());
        }
    }
    Ok(())
}
