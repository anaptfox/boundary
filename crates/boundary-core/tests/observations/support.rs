// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

use std::{
    collections::BTreeMap,
    error::Error,
    marker::PhantomData,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use boundary_core::{
    DeclaredErrorCodec, Interaction, PortableFault, PortableSchema, ReadFootprint, ReadOnly,
    SchemaType, WireCodec, WireError, interaction_id,
    lifecycle::{
        AdmitAll, BindResult, Bound, CallerError, InstallationController, InstallationId,
        ProjectionHandle, ProjectionModes, RealizationId, admit_all, bind, compile_interaction,
        install, observed_read_realization, project, select,
    },
    observations::{
        EvidenceValidation, Observation, ObservationFault, ObservationSnapshot, ObservationView,
        ObservedReadOptions, PointObservation, QueryObservation, ReadDiagnostic, ReadEvaluator,
        SnapshotSource,
    },
};
use futures::executor::block_on;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Row {
    pub id: u32,
    pub title: String,
    pub completed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Query {
    pub completed: Option<bool>,
    pub order: String,
    pub offset: usize,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Read {
    pub key: Option<String>,
    pub query: Option<Query>,
    pub selector: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Reply {
    pub point: Option<Value>,
    pub rows: Vec<Row>,
    #[serde(skip)]
    pub retention: Arc<()>,
}

#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[error("read evaluation failed")]
pub(crate) struct ReadFault {
    code: String,
}
impl PortableFault for ReadFault {
    fn code(&self) -> &'static str {
        "read.failed"
    }
}

// Every successful test call also proves that native observed execution avoids
// JSON encoding/decoding: these intentionally unavailable codecs cannot run.
pub(crate) struct NativeCodec<T>(PhantomData<T>);
impl<T: Send + Sync + 'static> WireCodec<T> for NativeCodec<T> {
    fn schema() -> Result<PortableSchema, WireError> {
        Ok(PortableSchema::of_type(SchemaType::Object))
    }
    fn encode(_value: &T) -> Result<Value, WireError> {
        Err(WireError::Encode("native only".to_owned()))
    }
    fn decode(_value: Value) -> Result<T, WireError> {
        Err(WireError::Decode("native only".to_owned()))
    }
}

impl DeclaredErrorCodec<ReadFault> for NativeCodec<ReadFault> {
    fn schema() -> Result<Option<PortableSchema>, WireError> {
        Ok(Some(PortableSchema::of_type(SchemaType::Object)))
    }
    fn encode(_error: &ReadFault) -> Result<Value, WireError> {
        Err(WireError::Encode("native error only".to_owned()))
    }
    fn decode(_value: Value) -> Result<ReadFault, WireError> {
        Err(WireError::Decode("native error only".to_owned()))
    }
}

impl Interaction for Read {
    const ID: boundary_core::StaticInteractionId = interaction_id!("tests.observed.read");
    type Output = Reply;
    type Error = ReadFault;
    type Effect = ReadOnly;
    type InputCodec = NativeCodec<Self>;
    type OutputCodec = NativeCodec<Reply>;
    type ErrorCodec = NativeCodec<ReadFault>;
    fn footprint() -> ReadFootprint {
        ReadFootprint::new(&["test-data"])
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Token {
    Point(Option<Value>),
    Query(Vec<Row>),
}

#[derive(Clone, Default)]
#[allow(clippy::struct_excessive_bools)] // Independent fault injection controls.
pub(crate) struct Data {
    pub points: BTreeMap<String, Value>,
    pub rows: Vec<Row>,
    pub unavailable: bool,
    pub invalid_reads: bool,
    pub invalid_validation: bool,
    pub incomplete: bool,
    pub snapshot_failure: bool,
    pub after_callback_failure: bool,
}

pub(crate) struct Snapshot(pub Data);

pub(crate) fn query_rows(rows: &[Row], query: &Query) -> Vec<Row> {
    let mut result: Vec<_> = rows
        .iter()
        .filter(|row| query.completed.is_none_or(|value| row.completed == value))
        .cloned()
        .collect();
    if query.order == "id-asc" {
        result.sort_by_key(|row| row.id);
    }
    result
        .into_iter()
        .skip(query.offset)
        .take(query.limit.unwrap_or(usize::MAX))
        .collect()
}

impl ObservationSnapshot for Snapshot {
    type Key = String;
    type Query = Query;
    type Value = Value;
    type QueryResult = Vec<Row>;
    type Token = Token;
    fn get(&self, key: &String) -> Result<PointObservation<Value, Token>, ObservationFault> {
        if self.0.invalid_reads {
            return Err(ObservationFault::Unavailable);
        }
        let value = self.0.points.get(key).cloned();
        Ok(PointObservation {
            token: Token::Point(value.clone()),
            value,
        })
    }
    fn query(&self, query: &Query) -> Result<QueryObservation<Vec<Row>, Token>, ObservationFault> {
        if self.0.invalid_reads {
            return Err(ObservationFault::Unavailable);
        }
        let value = query_rows(&self.0.rows, query);
        Ok(QueryObservation {
            token: Token::Query(value.clone()),
            value,
        })
    }
    fn validate(
        &self,
        evidence: &Observation<String, Query, Token>,
    ) -> Result<EvidenceValidation, ObservationFault> {
        if self.0.invalid_validation {
            return Err(ObservationFault::Unavailable);
        }
        if self.0.unavailable {
            return Ok(EvidenceValidation::Unavailable);
        }
        if self.0.incomplete {
            return Ok(EvidenceValidation::Matching);
        }
        let matched = match evidence {
            Observation::Point {
                key,
                present,
                token: Token::Point(value),
            } => {
                self.0.points.get(key).cloned() == *value
                    && self.0.points.contains_key(key) == *present
            }
            Observation::Query {
                query,
                token: Token::Query(rows),
            } => query_rows(&self.0.rows, query) == *rows,
            _ => false,
        };
        Ok(if matched {
            EvidenceValidation::Matching
        } else {
            EvidenceValidation::Changed
        })
    }
}

#[derive(Clone)]
pub(crate) struct Source(pub Arc<Mutex<Data>>);

pub(crate) struct Context {
    pub scope: usize,
    pub allow: bool,
}

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
        let data = self
            .0
            .lock()
            .map_err(|_| ObservationFault::Unavailable)?
            .clone();
        if data.snapshot_failure {
            return Err(ObservationFault::Unavailable);
        }
        let after_callback_failure = data.after_callback_failure;
        let result = callback(&Snapshot(data));
        if after_callback_failure {
            return Err(ObservationFault::Unavailable);
        }
        Ok(result)
    }
}

#[derive(Default)]
pub(crate) struct Stats {
    pub evaluations: AtomicUsize,
    pub authorizations: AtomicUsize,
    pub invalid_output: AtomicBool,
    pub evaluation_failure: AtomicBool,
    pub panicking_diagnostic: AtomicBool,
    pub diagnostics: Mutex<Vec<ReadDiagnostic>>,
    pub retention: Arc<()>,
}

#[derive(Clone)]
pub(crate) struct Evaluator(pub Arc<Stats>);

impl ReadEvaluator<Read, Context, Snapshot> for Evaluator {
    type Scope = usize;
    fn scope(&self, _input: &Read, context: &Context) -> usize {
        context.scope
    }
    async fn authorize(&self, _input: &Read, context: &Context) -> Result<(), ObservationFault> {
        self.0.authorizations.fetch_add(1, Ordering::SeqCst);
        if context.allow {
            Ok(())
        } else {
            Err(ObservationFault::Denied("host.denied".to_owned()))
        }
    }
    fn evaluate(
        &self,
        input: &Read,
        _context: &Context,
        view: &mut ObservationView<'_, Snapshot>,
    ) -> Result<Reply, ReadFault> {
        self.0.evaluations.fetch_add(1, Ordering::SeqCst);
        if self.0.evaluation_failure.load(Ordering::SeqCst) {
            return Err(ReadFault {
                code: "read.failed".to_owned(),
            });
        }
        // Errors deliberately ignored to prove an incomplete view cannot be retained.
        let selected = input
            .selector
            .as_ref()
            .and_then(|selector| view.get(selector).ok().flatten())
            .and_then(|value| value.as_str().map(str::to_owned));
        let point = selected
            .as_ref()
            .or(input.key.as_ref())
            .and_then(|key| view.get(key).ok().flatten());
        let rows = input
            .query
            .as_ref()
            .and_then(|query| view.query(query).ok())
            .unwrap_or_default();
        Ok(Reply {
            point,
            rows,
            retention: Arc::clone(&self.0.retention),
        })
    }
    fn valid_output(&self, _output: &Reply) -> bool {
        !self.0.invalid_output.load(Ordering::SeqCst)
    }
    fn diagnostic(&self, diagnostic: ReadDiagnostic) {
        if self.0.panicking_diagnostic.load(Ordering::SeqCst) {
            // The executor must isolate a host diagnostic failure from execution truth.
            std::panic::resume_unwind(Box::new("diagnostic failure"));
        }
        if let Ok(mut diagnostics) = self.0.diagnostics.lock() {
            diagnostics.push(diagnostic);
        }
    }
}

pub(crate) struct Rig {
    pub source: Source,
    pub stats: Arc<Stats>,
    pub bound: Bound<Context, AdmitAll>,
    pub handle: ProjectionHandle<Read>,
    pub controller: InstallationController<Context>,
}

impl Rig {
    pub(crate) fn new(
        data: Data,
        options: ObservedReadOptions,
        id: &str,
    ) -> Result<Self, Box<dyn Error>> {
        let source = Source(Arc::new(Mutex::new(data)));
        let stats = Arc::new(Stats::default());
        Self::with_shared(source, stats, options, id)
    }
    pub(crate) fn with_shared(
        source: Source,
        stats: Arc<Stats>,
        options: ObservedReadOptions,
        id: &str,
    ) -> Result<Self, Box<dyn Error>> {
        let interaction = compile_interaction::<Read>()?;
        let projection = project([select("read", &interaction, ProjectionModes::Direct)?])?;
        let handle = projection.handles().get("read", &interaction)?;
        let installed = install(
            InstallationId::new(format!("test/{id}/install"))?,
            [observed_read_realization(
                &interaction,
                RealizationId::new(format!("test/{id}/realization"))?,
                source.clone(),
                Evaluator(Arc::clone(&stats)),
                options,
            )],
        )?;
        let bound = match bind(&projection, &installed.installation, admit_all()) {
            BindResult::Bound(bound) => *bound,
            BindResult::Unrealized(_) => return Err("unexpected unrealized observed read".into()),
        };
        Ok(Self {
            source,
            stats,
            bound,
            handle,
            controller: installed.controller,
        })
    }
    pub(crate) fn call(&self, read: Read, scope: usize) -> Result<Reply, CallerError<ReadFault>> {
        block_on(self.bound.binding.caller().call(
            &Context { scope, allow: true },
            &self.handle,
            read,
        ))
    }
    pub(crate) fn replace(&self, data: Data) -> Result<(), Box<dyn Error>> {
        *self.source.0.lock().map_err(|_| "source poisoned")? = data;
        Ok(())
    }
    pub(crate) fn evaluations(&self) -> usize {
        self.stats.evaluations.load(Ordering::SeqCst)
    }
    pub(crate) fn last_reused(&self) -> Result<bool, Box<dyn Error>> {
        self.stats
            .diagnostics
            .lock()
            .map_err(|_| "diagnostics poisoned")?
            .last()
            .map(|item| item.reused)
            .ok_or_else(|| "no diagnostic".into())
    }
}

pub(crate) fn point(key: &str) -> Read {
    Read {
        key: Some(key.to_owned()),
        query: None,
        selector: None,
    }
}
pub(crate) fn query(query: Query) -> Read {
    Read {
        key: None,
        query: Some(query),
        selector: None,
    }
}
