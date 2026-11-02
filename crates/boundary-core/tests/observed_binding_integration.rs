// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Compatible contract binding, restriction, and observed reuse compose natively.

use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use boundary_core::{
    Compatibility, Interaction, JsonCodec, NoError, ReadFootprint, ReadOnly,
    contract_compatibility,
    handoff::{
        HandoffFaultCause, HandoffInvocation, HandoffOutcome, HandoffTransport, RemoteCallError,
        RemoteCaller, TransportFault, checked_handoff,
    },
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, Binding, BindingManifest,
        Bound, InstallationId, InvocationCertainty, ProjectionModes, RealizationId,
        UnrealizedReason, admit_all, bind, compile_interaction, install, observed_read_realization,
        project, restrict_binding, select,
    },
    observations::{
        EvidenceValidation, Observation, ObservationFault, ObservationSnapshot, ObservationView,
        ObservedReadOptions, PointObservation, QueryObservation, ReadEvaluator, ReadReuse,
        SnapshotSource,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ExpectedRead {
    key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ActualRead {
    key: String,
}

impl Interaction for ExpectedRead {
    const ID: boundary_core::StaticInteractionId = interaction_id!("integration.observed.read");
    type Output = Option<String>;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<Option<String>>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["integration-data"])
    }
}

impl Interaction for ActualRead {
    const ID: boundary_core::StaticInteractionId = ExpectedRead::ID;
    type Output = String;
    type Error = NoError;
    type Effect = ReadOnly;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = NoError;
    fn footprint() -> ReadFootprint {
        ExpectedRead::footprint()
    }
}

struct Context {
    admit: AtomicBool,
    authorize: AtomicBool,
}

#[derive(Default)]
struct Stats {
    parent_admissions: AtomicUsize,
    child_admissions: AtomicUsize,
    authorizations: AtomicUsize,
    evaluations: AtomicUsize,
    validations: AtomicUsize,
    aliases: Mutex<Vec<String>>,
}

struct Policy {
    parent: bool,
    stats: Arc<Stats>,
}

impl Admission<Context> for Policy {
    async fn admit<'a>(&'a self, request: AdmissionRequest<'a, Context>) -> AdmissionDecision {
        let counter = if self.parent {
            &self.stats.parent_admissions
        } else {
            &self.stats.child_admissions
        };
        counter.fetch_add(1, Ordering::SeqCst);
        self.stats
            .aliases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request.interaction().alias().to_owned());
        if request.portable_input().is_some() && request.context().admit.load(Ordering::SeqCst) {
            AdmissionDecision::Admit
        } else {
            AdmissionDecision::Deny {
                code: "integration.admission-denied".to_owned(),
            }
        }
    }
}

#[derive(Clone)]
struct Snapshot {
    value: String,
    stats: Arc<Stats>,
}

impl ObservationSnapshot for Snapshot {
    type Key = String;
    type Query = ();
    type Value = String;
    type QueryResult = ();
    type Token = String;

    fn get(&self, _key: &String) -> Result<PointObservation<String, String>, ObservationFault> {
        Ok(PointObservation {
            value: Some(self.value.clone()),
            token: self.value.clone(),
        })
    }

    fn query(&self, _query: &()) -> Result<QueryObservation<(), String>, ObservationFault> {
        Err(ObservationFault::Unavailable)
    }

    fn validate(
        &self,
        evidence: &Observation<String, (), String>,
    ) -> Result<EvidenceValidation, ObservationFault> {
        self.stats.validations.fetch_add(1, Ordering::SeqCst);
        Ok(match evidence {
            Observation::Point {
                present: true,
                token,
                ..
            } if token == &self.value => EvidenceValidation::Matching,
            _ => EvidenceValidation::Changed,
        })
    }
}

struct Source(Arc<Mutex<Snapshot>>);

impl SnapshotSource<Context> for Source {
    type Snapshot = Snapshot;
    async fn with_snapshot<'a, R, F>(
        &'a self,
        _context: &'a Context,
        callback: F,
    ) -> Result<R, ObservationFault>
    where
        R: Send + 'a,
        F: FnOnce(&Snapshot) -> R + Send + 'a,
    {
        let snapshot = self
            .0
            .lock()
            .map_err(|_| ObservationFault::Unavailable)?
            .clone();
        Ok(callback(&snapshot))
    }
}

struct Evaluator(Arc<Stats>);

impl ReadEvaluator<ActualRead, Context, Snapshot> for Evaluator {
    type Scope = ();
    fn scope(&self, _input: &ActualRead, _context: &Context) {}

    async fn authorize(
        &self,
        _input: &ActualRead,
        context: &Context,
    ) -> Result<(), ObservationFault> {
        self.0.authorizations.fetch_add(1, Ordering::SeqCst);
        if context.authorize.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(ObservationFault::Denied(
                "integration.read-denied".to_owned(),
            ))
        }
    }

    fn evaluate(
        &self,
        input: &ActualRead,
        _context: &Context,
        view: &mut ObservationView<'_, Snapshot>,
    ) -> Result<String, NoError> {
        self.0.evaluations.fetch_add(1, Ordering::SeqCst);
        Ok(view.get(&input.key).ok().flatten().unwrap_or_default())
    }

    fn valid_output(&self, output: &String) -> bool {
        !output.is_empty()
    }
}

struct Loopback<'a, A> {
    binding: &'a Binding<Context, A>,
    context: &'a Context,
}

impl<A: Admission<Context>> HandoffTransport for Loopback<'_, A> {
    async fn invoke(
        &self,
        invocation: HandoffInvocation,
    ) -> Result<HandoffOutcome, TransportFault> {
        checked_handoff(self.binding)
            .invoke(invocation, self.context)
            .await
            .map_err(|_| TransportFault)
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

fn assert_retained_pins(parent: &BindingManifest, child: &BindingManifest) {
    assert_eq!(child.installation_id(), parent.installation_id());
    assert_eq!(child.installation_digest(), parent.installation_digest());
    assert_eq!(
        child.expected_program_digest(),
        parent.expected_program_digest()
    );
    assert_eq!(
        child.actual_program_digest(),
        parent.actual_program_digest()
    );
    assert_eq!(child.actual_catalog(), parent.actual_catalog());
    let expected = &parent.interactions()[0];
    let actual = &child.interactions()[0];
    assert_eq!(
        actual.expected_contract_digest(),
        expected.expected_contract_digest()
    );
    assert_eq!(
        actual.actual_contract_digest(),
        expected.actual_contract_digest()
    );
    assert_eq!(actual.realization_id(), expected.realization_id());
    assert_eq!(actual.input_arity(), expected.input_arity());
    assert_eq!(actual.mode(), expected.mode());
    assert_eq!(actual.alias(), "read");
}

fn counts(stats: &Stats) -> [usize; 5] {
    [
        stats.parent_admissions.load(Ordering::SeqCst),
        stats.child_admissions.load(Ordering::SeqCst),
        stats.authorizations.load(Ordering::SeqCst),
        stats.evaluations.load(Ordering::SeqCst),
        stats.validations.load(Ordering::SeqCst),
    ]
}

fn assert_portable_execution<T: HandoffTransport>(
    caller: &RemoteCaller<T>,
    handle: &boundary_core::lifecycle::ProjectionHandle<ExpectedRead>,
    context: &Context,
    stats: &Stats,
    data: &Mutex<Snapshot>,
) -> Result<(), Box<dyn Error>> {
    let call = || {
        block_on(caller.call(
            handle,
            ExpectedRead {
                key: "answer".to_owned(),
            },
        ))
    };
    assert_eq!(call()?, Some("first".to_owned()));
    assert_eq!(call()?, Some("first".to_owned()));
    assert_eq!(counts(stats), [2, 2, 2, 1, 1]);
    assert_eq!(
        *stats.aliases.lock().map_err(|_| "aliases poisoned")?,
        ["oldRead", "read", "oldRead", "read"]
    );

    // A retained result cannot bypass either admission or fresh read authorization.
    context.admit.store(false, Ordering::SeqCst);
    assert!(matches!(call(), Err(RemoteCallError::Denied { code })
        if code == "integration.admission-denied"));
    assert_eq!(counts(stats), [3, 2, 2, 1, 1]);
    context.admit.store(true, Ordering::SeqCst);
    context.authorize.store(false, Ordering::SeqCst);
    assert!(matches!(call(), Err(RemoteCallError::Denied { code })
        if code == "integration.read-denied"));
    assert_eq!(counts(stats), [4, 3, 3, 1, 1]);

    context.authorize.store(true, Ordering::SeqCst);
    assert_eq!(call()?, Some("first".to_owned()));
    assert_eq!(counts(stats), [5, 4, 4, 1, 2]);
    "second".clone_into(&mut data.lock().map_err(|_| "snapshot poisoned")?.value);
    assert_eq!(call()?, Some("second".to_owned()));
    assert_eq!(counts(stats), [6, 5, 5, 2, 3]);
    Ok(())
}

#[test]
fn compatible_observed_realization_preserves_parent_pins_and_policy_through_restriction()
-> Result<(), Box<dyn Error>> {
    let expected = compile_interaction::<ExpectedRead>()?;
    let actual = compile_interaction::<ActualRead>()?;
    assert_eq!(
        contract_compatibility(
            expected.descriptor().contract(),
            actual.descriptor().contract()
        ),
        Compatibility::Compatible
    );
    assert_ne!(expected.contract_digest(), actual.contract_digest());
    let parent_projection = project([select("oldRead", &expected, ProjectionModes::Direct)?])?;
    let child_projection = project([select("read", &expected, ProjectionModes::Direct)?])?;
    let changed_projection = project([select("read", &actual, ProjectionModes::Direct)?])?;
    let stats = Arc::new(Stats::default());
    let data = Arc::new(Mutex::new(Snapshot {
        value: "first".to_owned(),
        stats: Arc::clone(&stats),
    }));
    let installed = install(
        InstallationId::new("integration:observed:installation")?,
        [observed_read_realization(
            &actual,
            RealizationId::new("integration:observed:actual")?,
            Source(Arc::clone(&data)),
            Evaluator(Arc::clone(&stats)),
            ObservedReadOptions {
                reuse: ReadReuse::Validated,
                max_entries: 1,
            },
        )],
    )?;
    let parent = bound(bind(
        &parent_projection,
        &installed.installation,
        Policy {
            parent: true,
            stats: Arc::clone(&stats),
        },
    ))?;
    let child = bound(restrict_binding(
        &parent.binding,
        &child_projection,
        Policy {
            parent: false,
            stats: Arc::clone(&stats),
        },
    ))?;
    let parent_manifest = parent.binding.manifest();
    assert_eq!(
        parent_manifest.interactions()[0].expected_contract_digest(),
        expected.contract_digest()
    );
    assert_eq!(
        parent_manifest.interactions()[0].actual_contract_digest(),
        actual.contract_digest()
    );
    assert_retained_pins(parent_manifest, child.binding.manifest());
    match restrict_binding(&parent.binding, &changed_projection, admit_all()) {
        BindResult::Unrealized(report) => assert!(
            report
                .issues()
                .iter()
                .any(|issue| issue.reason() == UnrealizedReason::ContractNotSelected)
        ),
        BindResult::Bound(_) => return Err("restriction replaced the expected contract".into()),
    }

    let context = Context {
        admit: AtomicBool::new(true),
        authorize: AtomicBool::new(true),
    };
    let handle = child_projection.handles().get("read", &expected)?;
    let caller = RemoteCaller::new(
        child.binding.manifest().clone(),
        Loopback {
            binding: &child.binding,
            context: &context,
        },
    );
    assert_portable_execution(&caller, &handle, &context, &stats, &data)?;
    assert!(parent.controller.revoke());
    assert!(matches!(
        block_on(caller.call(
            &handle,
            ExpectedRead {
                key: "answer".to_owned()
            }
        )),
        Err(RemoteCallError::Fault {
            cause: HandoffFaultCause::Revoked,
            certainty: InvocationCertainty::NotStarted,
        })
    ));
    assert_eq!(counts(&stats), [6, 5, 5, 2, 3]);
    Ok(())
}
