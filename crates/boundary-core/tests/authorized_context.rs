#![allow(unknown_lints, clippy::unused_async_trait_impl)]
#![allow(clippy::panic)]

//! Authorized context narrowing reaches direct and observed realizations.

use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use boundary_core::{
    Handler, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly, interaction_id,
    lifecycle::{
        AuthorizationDecision, AuthorizationRequest, AuthorizedBindResult, Authorizer, CallerError,
        InstallationId, ProjectionModes, RealizationId, UnrealizedReport, bind_authorized,
        compile_interaction, direct_realization, install, observed_read_realization, project,
        select,
    },
    observations::{
        EvidenceValidation, Observation, ObservationFault, ObservationSnapshot, ObservationView,
        ObservedReadOptions, PointObservation, QueryObservation, ReadEvaluator, SnapshotSource,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Echo {
    value: String,
}

impl Interaction for Echo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("authorized.echo");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["authorized-echo"])
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    key: String,
}

impl Interaction for Observed {
    const ID: boundary_core::StaticInteractionId = interaction_id!("authorized.observed");
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;

    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["authorized-observed"])
    }
}

#[derive(Clone)]
struct RawActor {
    token: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthorizedUser {
    user_id: String,
    role: String,
}

#[derive(Default)]
struct Counts {
    authorizations: AtomicUsize,
    direct_calls: AtomicUsize,
    observed_calls: AtomicUsize,
}

struct Policy(Arc<Counts>);

impl Authorizer<RawActor, AuthorizedUser> for Policy {
    fn authorize<'a>(
        &'a self,
        request: AuthorizationRequest<'a, RawActor>,
    ) -> impl Future<Output = AuthorizationDecision<AuthorizedUser>> + Send + 'a {
        self.0.authorizations.fetch_add(1, Ordering::SeqCst);
        std::future::ready(if request.context().token == "valid" && request.is_live() {
            AuthorizationDecision::Allow(AuthorizedUser {
                user_id: "user-7".to_owned(),
                role: "reader".to_owned(),
            })
        } else {
            AuthorizationDecision::Deny {
                code: "auth.invalid-token".to_owned(),
            }
        })
    }
}

struct EchoHandler(Arc<Counts>);

impl Handler<Echo, AuthorizedUser> for EchoHandler {
    async fn handle(&self, context: &AuthorizedUser, input: Echo) -> Result<String, NoError> {
        self.0.direct_calls.fetch_add(1, Ordering::SeqCst);
        Ok(format!(
            "{}:{}:{}",
            context.user_id, context.role, input.value
        ))
    }
}

#[derive(Clone)]
struct Source;

struct Snapshot;

impl SnapshotSource<AuthorizedUser> for Source {
    type Snapshot = Snapshot;

    async fn with_snapshot<'a, R, F>(
        &'a self,
        context: &'a AuthorizedUser,
        callback: F,
    ) -> Result<R, ObservationFault>
    where
        R: Send + 'a,
        F: FnOnce(&Snapshot) -> R + Send + 'a,
    {
        if context.user_id != "user-7" {
            return Err(ObservationFault::Unavailable);
        }
        Ok(callback(&Snapshot))
    }
}

struct Evaluator(Arc<Counts>);

impl ReadEvaluator<Observed, AuthorizedUser, Snapshot> for Evaluator {
    type Scope = ();

    fn scope(&self, _input: &Observed, _context: &AuthorizedUser) {}

    async fn authorize(
        &self,
        _input: &Observed,
        context: &AuthorizedUser,
    ) -> Result<(), ObservationFault> {
        if context.role == "reader" {
            Ok(())
        } else {
            Err(ObservationFault::Denied("wrong-role".to_owned()))
        }
    }

    fn evaluate(
        &self,
        input: &Observed,
        context: &AuthorizedUser,
        _view: &mut ObservationView<'_, Snapshot>,
    ) -> Result<String, NoError> {
        self.0.observed_calls.fetch_add(1, Ordering::SeqCst);
        Ok(format!(
            "{}:{}:{}",
            context.user_id, context.role, input.key
        ))
    }

    fn valid_output(&self, output: &String) -> bool {
        !output.is_empty()
    }
}

impl ObservationSnapshot for Snapshot {
    type Key = String;
    type Query = ();
    type Value = String;
    type QueryResult = ();
    type Token = ();

    fn get(&self, _key: &String) -> Result<PointObservation<String, ()>, ObservationFault> {
        Ok(PointObservation {
            value: None,
            token: (),
        })
    }

    fn query(&self, _query: &()) -> Result<QueryObservation<(), ()>, ObservationFault> {
        Err(ObservationFault::Unavailable)
    }

    fn validate(
        &self,
        _evidence: &Observation<String, (), ()>,
    ) -> Result<EvidenceValidation, ObservationFault> {
        Ok(EvidenceValidation::Matching)
    }
}

type Fixture = (
    boundary_core::lifecycle::Projection,
    boundary_core::lifecycle::Installed<AuthorizedUser>,
    Arc<Counts>,
);

fn fixture() -> Result<Fixture, Box<dyn Error>> {
    let echo = compile_interaction::<Echo>()?;
    let observed = compile_interaction::<Observed>()?;
    let projection = project([
        select("echo", &echo, ProjectionModes::Direct)?,
        select("observed", &observed, ProjectionModes::Direct)?,
    ])?;
    let counts = Arc::new(Counts::default());
    let installation = install(
        InstallationId::new("authorized-context-test")?,
        [
            direct_realization(
                &echo,
                RealizationId::new("authorized.echo.realization")?,
                EchoHandler(Arc::clone(&counts)),
            ),
            observed_read_realization(
                &observed,
                RealizationId::new("authorized.observed.realization")?,
                Source,
                Evaluator(Arc::clone(&counts)),
                ObservedReadOptions::default(),
            ),
        ],
    )?;
    Ok((projection, installation, counts))
}

fn handle<O: Interaction>(
    projection: &boundary_core::lifecycle::Projection,
    alias: &str,
) -> Result<boundary_core::lifecycle::ProjectionHandle<O>, Box<dyn Error>> {
    let interaction = compile_interaction::<O>()?;
    Ok(projection.handles().get(alias, &interaction)?)
}

fn bound(
    result: AuthorizedBindResult<RawActor, AuthorizedUser, Policy>,
) -> Result<
    Box<boundary_core::lifecycle::AuthorizedBound<RawActor, AuthorizedUser, Policy>>,
    Box<UnrealizedReport>,
> {
    match result {
        AuthorizedBindResult::Bound(bound) => Ok(bound),
        AuthorizedBindResult::Unrealized(report) => Err(Box::new(report)),
    }
}

#[test]
fn narrows_caller_context_for_direct_and_observed_realizations() -> Result<(), Box<dyn Error>> {
    let (projection, installed, counts) = fixture()?;
    let authorized = bound(bind_authorized(
        &projection,
        &installed.installation,
        Policy(Arc::clone(&counts)),
    ))
    .map_err(|report| format!("unexpected unrealized: {}", report.issues().len()))?;
    let caller = authorized.binding.caller();
    let raw = RawActor {
        token: "valid".to_owned(),
    };
    let echo = block_on(caller.call(
        &handle::<Echo>(&projection, "echo")?,
        Echo {
            value: "hello".to_owned(),
        },
        &raw,
    ))?;
    assert_eq!(echo, "user-7:reader:hello");
    let observed = block_on(caller.call(
        &handle::<Observed>(&projection, "observed")?,
        Observed {
            key: "item".to_owned(),
        },
        &raw,
    ))?;
    assert_eq!(observed, "user-7:reader:item");
    assert_eq!(counts.authorizations.load(Ordering::SeqCst), 2);
    assert_eq!(counts.direct_calls.load(Ordering::SeqCst), 1);
    assert_eq!(counts.observed_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn denial_and_revocation_do_not_invoke_realizations() -> Result<(), Box<dyn Error>> {
    let (projection, installed, counts) = fixture()?;
    let authorized = bound(bind_authorized(
        &projection,
        &installed.installation,
        Policy(Arc::clone(&counts)),
    ))
    .map_err(|report| format!("unexpected unrealized: {}", report.issues().len()))?;
    let caller = authorized.binding.caller();
    let handle = handle::<Echo>(&projection, "echo")?;
    let invalid = RawActor {
        token: "invalid".to_owned(),
    };
    assert!(matches!(
        block_on(caller.call(&handle, Echo { value: "x".to_owned() }, &invalid)),
        Err(CallerError::Denied { code }) if code == "auth.invalid-token"
    ));
    assert_eq!(counts.direct_calls.load(Ordering::SeqCst), 0);

    assert!(authorized.controller.revoke());
    let valid = RawActor {
        token: "valid".to_owned(),
    };
    assert!(matches!(
        block_on(caller.call(
            &handle,
            Echo {
                value: "x".to_owned()
            },
            &valid
        )),
        Err(CallerError::Revoked)
    ));
    assert_eq!(counts.authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(counts.direct_calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn missing_realization_is_returned_as_unrealized() -> Result<(), Box<dyn Error>> {
    let echo = compile_interaction::<Echo>()?;
    let projection = project([select("echo", &echo, ProjectionModes::Direct)?])?;
    let empty = install::<AuthorizedUser>(InstallationId::new("empty-authorized")?, [])?;
    assert!(matches!(
        bind_authorized::<RawActor, _, _>(
            &projection,
            &empty.installation,
            Policy(Arc::new(Counts::default()))
        ),
        AuthorizedBindResult::Unrealized(_)
    ));
    Ok(())
}
