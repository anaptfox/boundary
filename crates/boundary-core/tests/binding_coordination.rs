// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Reviewed host-coordination laws exercised by independent native Rust paths.
use boundary_core::{
    Handler, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly,
    handoff::{HandoffInvocation, HandoffOutcome, HandoffResult, checked_handoff},
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, Binding, BindingController,
        Bound, CoordinatedInvocation, CoordinationError, CoordinationFuture, InstallationId,
        InteractionMode, InvocationCertainty, InvocationContinuation, InvocationCoordinator,
        ProjectionModes, RealizationId, RequestCapability, RequestCapabilityFault,
        RequestControlDigest, RequestIdentity, admit_all, bind, compile_interaction,
        coordinate_binding, describe_binding, direct_realization, identified_request_realization,
        install, project, restrict_binding, select,
    },
};
use futures::{channel::oneshot, executor::block_on};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

#[path = "coordination/queue.rs"]
mod queue;

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct Echo {
    value: String,
}
impl Interaction for Echo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("coordination.echo");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["document"])
    }
}
struct Context {
    allow: bool,
    dispatches: AtomicUsize,
    hooks: AtomicUsize,
    admissions: AtomicUsize,
    address: AtomicUsize,
    controller: Arc<Mutex<Option<BindingController>>>,
}
impl Context {
    fn new(allow: bool) -> Self {
        Self {
            allow,
            dispatches: AtomicUsize::new(0),
            hooks: AtomicUsize::new(0),
            admissions: AtomicUsize::new(0),
            address: AtomicUsize::new(0),
            controller: Arc::default(),
        }
    }
}
struct Policy;
impl Admission<Context> for Policy {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, Context>) -> AdmissionDecision {
        request.context().admissions.fetch_add(1, Ordering::SeqCst);
        if request.context().allow {
            AdmissionDecision::Admit
        } else {
            AdmissionDecision::Deny {
                code: "policy-denied".into(),
            }
        }
    }
}
struct EchoHandler;
impl Handler<Echo, Context> for EchoHandler {
    async fn handle(&self, context: &Context, input: Echo) -> Result<String, NoError> {
        context.dispatches.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            context.address.load(Ordering::SeqCst),
            std::ptr::from_ref(context).addr()
        );
        Ok(input.value)
    }
}
struct EchoRequest;
impl RequestCapability<Echo, Context> for EchoRequest {
    async fn request<'a>(
        &'a self,
        context: &'a Context,
        input: Echo,
    ) -> Result<Value, RequestCapabilityFault> {
        context.dispatches.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            context.address.load(Ordering::SeqCst),
            std::ptr::from_ref(context).addr()
        );
        Ok(json!(input.value))
    }
}
struct Coordinator {
    behavior: String,
}
impl InvocationCoordinator<Context> for Coordinator {
    fn coordinate<'a>(
        &'a self,
        request: CoordinatedInvocation<'a, Context>,
        proceed: InvocationContinuation<'a>,
    ) -> CoordinationFuture<'a> {
        Box::pin(async move {
            request.context().hooks.fetch_add(1, Ordering::SeqCst);
            assert!(request.context().admissions.load(Ordering::SeqCst) > 0);
            assert_eq!(
                request.context().address.load(Ordering::SeqCst),
                std::ptr::from_ref(request.context()).addr()
            );
            assert_eq!(request.input(), &json!({"value":"fresh"}));
            match self.behavior.as_str() {
                "proceed" => proceed.proceed().await,
                "revoke" => {
                    let (send, receive) = oneshot::channel();
                    send.send(()).map_err(|()| CoordinationError)?;
                    receive.await.map_err(|_| CoordinationError)?;
                    if let Some(controller) = request
                        .context()
                        .controller
                        .lock()
                        .map_err(|_| CoordinationError)?
                        .as_ref()
                    {
                        let _ = controller.revoke();
                    }
                    proceed.proceed().await
                }
                "error" => Err(CoordinationError),
                "unknown" => request
                    .outcome(
                        InvocationCertainty::Unknown,
                        HandoffResult::Fault {
                            cause: boundary_core::handoff::HandoffFaultCause::RealizationFailed,
                            issues: vec![],
                        },
                    )
                    .map_err(|_| CoordinationError),
                "wrong-pins" => {
                    let outcome = request
                        .outcome(
                            InvocationCertainty::Completed,
                            HandoffResult::Returned {
                                value: json!("retained"),
                            },
                        )
                        .map_err(|_| CoordinationError)?;
                    let mut value = serde_json::to_value(outcome).map_err(|_| CoordinationError)?;
                    value["realizationId"] = json!("another-realization");
                    serde_json::from_value(value).map_err(|_| CoordinationError)
                }
                behavior => request
                    .outcome(
                        InvocationCertainty::Completed,
                        HandoffResult::Returned {
                            value: if behavior == "wrong-output" {
                                json!(42)
                            } else {
                                json!("retained")
                            },
                        },
                    )
                    .map_err(|_| CoordinationError),
            }
        })
    }
}
fn bound<C: Sync + ?Sized, A>(
    result: BindResult<C, A>,
) -> Result<Box<Bound<C, A>>, Box<dyn Error>> {
    match result {
        BindResult::Bound(bound) => Ok(bound),
        BindResult::Unrealized(_) => Err("fixture failed to bind".into()),
    }
}
fn observed<A: Admission<Context>>(
    binding: &Binding<Context, A>,
    context: &Context,
) -> Result<HandoffOutcome, Box<dyn Error>> {
    let selected = binding
        .manifest()
        .interactions()
        .first()
        .ok_or("empty binding")?;
    let invocation = HandoffInvocation::new(
        binding.manifest(),
        selected.interaction_id(),
        selected.mode(),
        json!({"value":"fresh"}),
    )?;
    let observations = AtomicUsize::new(0);
    let outcome =
        block_on(
            checked_handoff(binding).invoke_observed(invocation, context, None, |_| async {
                observations.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(())
            }),
        )?;
    assert_eq!(observations.load(Ordering::SeqCst), 1);
    Ok(outcome)
}

#[test]
fn reviewed_coordination_laws_cover_checked_handoff_and_inherited_children()
-> Result<(), Box<dyn Error>> {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/invocation-coordination.json"
    ))?;
    for row in vector["cases"].as_array().ok_or("missing laws")? {
        let echo = compile_interaction::<Echo>()?;
        let modes = if row["mode"] == "request" {
            ProjectionModes::Request
        } else {
            ProjectionModes::Direct
        };
        let projection = project([select("echo", &echo, modes)?])?;
        let installed = install(
            InstallationId::new("coordination:host")?,
            [
                direct_realization(&echo, RealizationId::new("coordination:echo")?, EchoHandler),
                identified_request_realization(
                    &echo,
                    RealizationId::new("coordination:echo-request")?,
                    RequestIdentity::new(
                        RequestControlDigest::parse(format!("sha256:{}", "4".repeat(64)))?,
                        boundary_core::PortableSchema::from_value(json!({"type":"string"}))?,
                    ),
                    EchoRequest,
                ),
            ],
        )?;
        let context = Context::new(row["admit"].as_bool().ok_or("missing admission")?);
        context
            .address
            .store(std::ptr::from_ref(&context).addr(), Ordering::SeqCst);
        let parent = coordinate_binding(
            *bound(bind(&projection, &installed.installation, Policy))?,
            Coordinator {
                behavior: row["coordinate"].as_str().ok_or("missing behavior")?.into(),
            },
        )?;
        *context
            .controller
            .lock()
            .map_err(|_| "poisoned controller")? = Some(parent.controller);
        let outcome = if row["restricted"] == true {
            let child = bound(restrict_binding(&parent.binding, &projection, admit_all()))?;
            observed(&child.binding, &context)?
        } else {
            observed(&parent.binding, &context)?
        };
        let value = serde_json::to_value(&outcome)?;
        assert_eq!(value["result"]["kind"], row["resultKind"], "{}", row["law"]);
        assert_eq!(value["certainty"], row["certainty"], "{}", row["law"]);
        assert_eq!(
            context.hooks.load(Ordering::SeqCst),
            usize::try_from(row["hooks"].as_u64().ok_or("missing hooks")?)?
        );
        assert_eq!(
            context.dispatches.load(Ordering::SeqCst),
            usize::try_from(row["dispatches"].as_u64().ok_or("missing count")?)?
        );
    }
    Ok(())
}

#[test]
fn typed_calls_and_requests_share_coordination_and_preserve_unknown() -> Result<(), Box<dyn Error>>
{
    let echo = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &echo, ProjectionModes::DirectAndRequest)?])?;
    let installed = install(
        InstallationId::new("coordination:typed")?,
        [
            direct_realization(
                &echo,
                RealizationId::new("coordination:direct")?,
                EchoHandler,
            ),
            identified_request_realization(
                &echo,
                RealizationId::new("coordination:request")?,
                RequestIdentity::new(
                    RequestControlDigest::parse(format!("sha256:{}", "4".repeat(64)))?,
                    boundary_core::PortableSchema::from_value(json!({"type":"string"}))?,
                ),
                EchoRequest,
            ),
        ],
    )?;
    let context = Context::new(true);
    context
        .address
        .store(std::ptr::from_ref(&context).addr(), Ordering::SeqCst);
    let coordinated = coordinate_binding(
        *bound(bind(&projection, &installed.installation, Policy))?,
        Coordinator {
            behavior: "proceed".into(),
        },
    )?;
    let handle = projection.handles().get("echo", &echo)?;
    assert_eq!(
        block_on(coordinated.binding.caller().call(
            &context,
            &handle,
            Echo {
                value: "fresh".into()
            }
        ))?,
        "fresh"
    );
    assert_eq!(
        block_on(coordinated.binding.caller().request(
            &context,
            &handle,
            Echo {
                value: "fresh".into()
            }
        ))?,
        json!("fresh")
    );
    assert_eq!(context.hooks.load(Ordering::SeqCst), 2);
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 2);
    let uncertain = coordinate_binding(
        *bound(bind(&projection, &installed.installation, Policy))?,
        Coordinator {
            behavior: "error".into(),
        },
    )?;
    let error = block_on(uncertain.binding.caller().request(
        &context,
        &handle,
        Echo {
            value: "fresh".into(),
        },
    ))
    .err()
    .ok_or("unexpected proposal")?;
    assert_eq!(error.certainty(), InvocationCertainty::Unknown);
    let error = block_on(uncertain.binding.caller().call(
        &context,
        &handle,
        Echo {
            value: "fresh".into(),
        },
    ))
    .err()
    .ok_or("unexpected direct result")?;
    assert_eq!(error.certainty(), InvocationCertainty::Unknown);
    let request = HandoffInvocation::new(
        uncertain.binding.manifest(),
        handle.interaction_id(),
        InteractionMode::Request,
        json!({"value":"fresh"}),
    )?;
    let outcome = block_on(checked_handoff(&uncertain.binding).invoke(request, &context))?;
    let mut forbidden = serde_json::to_value(outcome)?;
    forbidden["certainty"] = json!("not-completed");
    assert!(serde_json::from_value::<HandoffOutcome>(forbidden).is_err());
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 2);
    Ok(())
}

#[test]
fn inherited_coordinator_cannot_be_replaced_and_input_is_checked_first()
-> Result<(), Box<dyn Error>> {
    let echo = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &echo, ProjectionModes::Direct)?])?;
    let installed = install(
        InstallationId::new("coordination:checked")?,
        [direct_realization(
            &echo,
            RealizationId::new("coordination:checked-direct")?,
            EchoHandler,
        )],
    )?;
    let parent = coordinate_binding(
        *bound(bind(&projection, &installed.installation, Policy))?,
        Coordinator {
            behavior: "retained".into(),
        },
    )?;
    let child = bound(restrict_binding(&parent.binding, &projection, admit_all()))?;
    assert!(
        coordinate_binding(
            *child,
            Coordinator {
                behavior: "proceed".into()
            }
        )
        .is_err()
    );
    let context = Context::new(true);
    let input = HandoffInvocation::new(
        parent.binding.manifest(),
        parent.binding.manifest().interactions()[0].interaction_id(),
        InteractionMode::Direct,
        json!({"value":42}),
    )?;
    let outcome = block_on(checked_handoff(&parent.binding).invoke(input, &context))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::NotStarted);
    assert_eq!(context.hooks.load(Ordering::SeqCst), 0);
    assert_eq!(context.admissions.load(Ordering::SeqCst), 0);
    assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn description_is_selected_only_and_retains_exact_request_pins() -> Result<(), Box<dyn Error>> {
    let echo = compile_interaction::<Echo>()?;
    let parent_projection = project([select("echo", &echo, ProjectionModes::DirectAndRequest)?])?;
    let child_projection = project([select("proposal", &echo, ProjectionModes::Request)?])?;
    let installed = install(
        InstallationId::new("description:host")?,
        [
            direct_realization(
                &echo,
                RealizationId::new("description:direct")?,
                EchoHandler,
            ),
            identified_request_realization(
                &echo,
                RealizationId::new("description:request")?,
                RequestIdentity::new(
                    RequestControlDigest::parse(format!("sha256:{}", "5".repeat(64)))?,
                    boundary_core::PortableSchema::from_value(json!({"type":"string"}))?,
                ),
                EchoRequest,
            ),
        ],
    )?;
    let parent = bound(bind(&parent_projection, &installed.installation, Policy))?;
    let child = bound(restrict_binding(
        &parent.binding,
        &child_projection,
        admit_all(),
    ))?;
    let description = describe_binding(&child.binding)?;
    assert_eq!(description.interactions().len(), 1);
    let selected = &description.interactions()[0];
    assert_eq!(selected.binding().alias(), "proposal");
    assert_eq!(selected.binding().mode(), InteractionMode::Request);
    assert_eq!(
        selected.expected().contract_digest(),
        selected.binding().expected_contract_digest()
    );
    assert_eq!(
        selected.actual().contract_digest(),
        selected.binding().actual_contract_digest()
    );
    assert_eq!(
        selected.binding().request_identity(),
        parent
            .binding
            .manifest()
            .interactions()
            .iter()
            .find(|entry| entry.mode() == InteractionMode::Request)
            .and_then(|entry| entry.request_identity())
    );
    let value = serde_json::to_value(description)?;
    assert!(value["interactions"][0].get("request").is_some());
    assert!(value.get("coordinators").is_none());
    Ok(())
}
