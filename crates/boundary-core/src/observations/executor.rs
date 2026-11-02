use std::{
    collections::VecDeque,
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{Interaction, ReadOnly};

use super::{
    EvidenceValidation, ObservationFault, ObservationSnapshot, ObservationView,
    ObservedReadOptions, ReadDiagnostic, ReadEvaluator, ReadReason, ReadReuse, SnapshotSource,
    view::Evidence,
};

pub(crate) enum ReadFailure<E> {
    Adapter(ObservationFault),
    Declared(E),
    InvalidOutput,
}

struct Entry<O: Interaction, Scope, S: ObservationSnapshot> {
    input: O,
    scope: Scope,
    output: O::Output,
    evidence: Vec<Evidence<S>>,
}

type Cache<O, Scope, S> = Mutex<VecDeque<Entry<O, Scope, S>>>;

struct Prepared<O: Interaction, Scope, S: ObservationSnapshot> {
    output: O::Output,
    retained: Option<Entry<O, Scope, S>>,
    diagnostic: ReadDiagnostic,
}

type PreparedResult<O, Scope, S> =
    Result<Prepared<O, Scope, S>, ReadFailure<<O as Interaction>::Error>>;

type SnapshotFuture<'a, O, Scope, S> = Pin<
    Box<dyn Future<Output = Result<PreparedResult<O, Scope, S>, ObservationFault>> + Send + 'a>,
>;

pub(crate) struct ObservedExecutor<O, C: Sync + ?Sized, Source, Eval>
where
    O: Interaction<Effect = ReadOnly>,
    Source: SnapshotSource<C>,
    Eval: ReadEvaluator<O, C, Source::Snapshot>,
{
    source: Source,
    evaluator: Eval,
    options: ObservedReadOptions,
    cache: Cache<O, Eval::Scope, Source::Snapshot>,
    closed: AtomicBool,
}

impl<O, C, Source, Eval> ObservedExecutor<O, C, Source, Eval>
where
    O: Interaction<Effect = ReadOnly> + Clone + Eq + Sync,
    O::Output: Clone,
    C: Sync + ?Sized,
    Source: SnapshotSource<C>,
    Eval: ReadEvaluator<O, C, Source::Snapshot>,
{
    pub(crate) fn new(source: Source, evaluator: Eval, options: ObservedReadOptions) -> Self {
        Self {
            source,
            evaluator,
            options,
            cache: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut entries) = self.cache.lock() {
            entries.clear();
        }
    }

    pub(crate) async fn call(
        &self,
        context: &C,
        input: O,
        valid_boundary_output: impl Fn(&O::Output) -> bool + Send + Sync,
    ) -> Result<O::Output, ReadFailure<O::Error>> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ReadFailure::Adapter(ObservationFault::Unavailable));
        }
        self.evaluator
            .authorize(&input, context)
            .await
            .map_err(ReadFailure::Adapter)?;
        let scope = self.evaluator.scope(&input, context);
        let prepared = self
            .prepare(context, input, scope, valid_boundary_output)
            .await
            .map_err(ReadFailure::Adapter)??;
        // The source can fail after running its callback. Nothing is retained
        // until the complete snapshot boundary returns a successful result.
        if let Some(candidate) = prepared.retained {
            self.retain(candidate);
        }
        self.report(prepared.diagnostic);
        Ok(prepared.output)
    }

    // Rust 1.88 cannot infer the snapshot future's higher-ranked associated-type
    // lifetimes through the installation's boxed async future. Erase that future
    // at this private seam without narrowing host snapshot or scope types.
    fn prepare<'a>(
        &'a self,
        context: &'a C,
        input: O,
        scope: Eval::Scope,
        valid_boundary_output: impl Fn(&O::Output) -> bool + Send + Sync + 'a,
    ) -> SnapshotFuture<'a, O, Eval::Scope, Source::Snapshot> {
        Box::pin(self.source.with_snapshot(context, move |snapshot| {
            self.in_snapshot(snapshot, context, input, scope, valid_boundary_output)
        }))
    }

    fn in_snapshot(
        &self,
        snapshot: &Source::Snapshot,
        context: &C,
        input: O,
        scope: Eval::Scope,
        valid_boundary_output: impl Fn(&O::Output) -> bool,
    ) -> PreparedResult<O, Eval::Scope, Source::Snapshot> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ReadFailure::Adapter(ObservationFault::Unavailable));
        }
        let retained = self.options.reuse == ReadReuse::Validated && self.options.max_entries > 0;
        let mut reason = if retained {
            ReadReason::Miss
        } else {
            ReadReason::ReuseOff
        };
        let mut validations = 0;
        if retained {
            let candidate = self.cache.lock().ok().and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.input == input && entry.scope == scope)
                    .map(|entry| (entry.output.clone(), entry.evidence.clone()))
            });
            if let Some((output, evidence)) = candidate {
                reason = ReadReason::Matching;
                for item in &evidence {
                    validations += 1;
                    match snapshot.validate(item) {
                        Ok(EvidenceValidation::Matching) => {}
                        Ok(EvidenceValidation::Changed) => {
                            reason = ReadReason::Changed;
                            break;
                        }
                        Ok(EvidenceValidation::Unavailable) | Err(_) => {
                            reason = ReadReason::Unavailable;
                            break;
                        }
                    }
                }
                if reason == ReadReason::Matching
                    && self.evaluator.valid_output(&output)
                    && valid_boundary_output(&output)
                {
                    return Ok(Prepared {
                        output,
                        retained: None,
                        diagnostic: ReadDiagnostic {
                            reused: true,
                            validations,
                            observations: evidence.len(),
                            reason,
                        },
                    });
                }
            }
        }
        let mut view = ObservationView::new(snapshot);
        let output = self
            .evaluator
            .evaluate(&input, context, &mut view)
            .map_err(ReadFailure::Declared)?;
        if !self.evaluator.valid_output(&output) || !valid_boundary_output(&output) {
            return Err(ReadFailure::InvalidOutput);
        }
        let observations = view.evidence.len();
        Ok(Prepared {
            retained: (retained && !view.failed).then(|| Entry {
                input,
                scope,
                output: output.clone(),
                evidence: view.evidence,
            }),
            output,
            diagnostic: ReadDiagnostic {
                reused: false,
                validations,
                observations,
                reason,
            },
        })
    }

    fn retain(&self, candidate: Entry<O, Eval::Scope, Source::Snapshot>) {
        if let Ok(mut entries) = self.cache.lock() {
            // Close and insertion are ordered by this lock: revocation cannot
            // leave an entry retained by an in-flight evaluator.
            if !self.closed.load(Ordering::Acquire) {
                entries.retain(|entry| {
                    entry.input != candidate.input || entry.scope != candidate.scope
                });
                if entries.len() >= self.options.max_entries {
                    entries.pop_front();
                }
                entries.push_back(candidate);
            }
        }
    }

    fn report(&self, diagnostic: ReadDiagnostic) {
        let _ = catch_unwind(AssertUnwindSafe(|| self.evaluator.diagnostic(diagnostic)));
    }
}
