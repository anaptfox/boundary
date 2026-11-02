// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Local, opt-in baseline timings for boundary-core public hot paths.

use std::{env, fs, process, time::Instant};

use boundary_core::{
    ChangeFootprint, ChangesState, Handler, Interaction, JsonCodec, PortableFault, PortableSchema,
    handoff::{HandoffInvocation, HandoffResult, checked_handoff},
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, InstallationId,
        InteractionMode, ProjectionHandle, ProjectionModes, RealizationId, admit_all, bind,
        compile_interaction, direct_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error as ThisError;

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct ChangeCounter {
    by: String,
    reject: bool,
}

#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, ThisError)]
#[serde(deny_unknown_fields)]
#[error("counter rejected: {code}")]
struct CounterFault {
    code: String,
}

impl PortableFault for CounterFault {
    fn code(&self) -> &'static str {
        "counter.rejected"
    }
}

impl Interaction for ChangeCounter {
    const ID: boundary_core::StaticInteractionId =
        interaction_id!("tests.lifecycle.change-counter");

    type Output = String;
    type Error = CounterFault;
    type Effect = ChangesState;
    type InputCodec = JsonCodec<Self>;
    type OutputCodec = JsonCodec<String>;
    type ErrorCodec = JsonCodec<CounterFault>;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["counter"], &["counter"])
    }
}

struct AppContext;

struct ContextAdmission;

impl Admission<AppContext> for ContextAdmission {
    async fn admit<'a>(&'a self, _request: AdmissionRequest<'a, AppContext>) -> AdmissionDecision {
        AdmissionDecision::Admit
    }
}

struct ContextHandler;

impl Handler<ChangeCounter, AppContext> for ContextHandler {
    async fn handle(
        &self,
        _context: &AppContext,
        interaction: ChangeCounter,
    ) -> Result<String, CounterFault> {
        if interaction.reject {
            return Err(CounterFault {
                code: "counter.rejected".to_owned(),
            });
        }
        Ok(interaction.by)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchCase {
    id: String,
    lang: &'static str,
    class: &'static str,
    iters: usize,
    ns_median: u64,
    ns_p95: u64,
    warmup: usize,
    batch_size: usize,
    timing_mode: &'static str,
    sample_unit: &'static str,
    samples_ns: Vec<u64>,
    statistic: &'static str,
}

fn fail(error: impl std::fmt::Display) -> ! {
    eprintln!("boundary-core bench failed: {error}");
    process::exit(1);
}

fn require<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => fail(error),
    }
}

fn percentile(sorted: &[u64], p: u8) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (sorted.len() * usize::from(p))
        .div_ceil(100)
        .saturating_sub(1);
    sorted[rank.min(sorted.len() - 1)]
}

fn measure(warmup: usize, iters: usize, mut body: impl FnMut()) -> (Vec<u64>, u64, u64) {
    for _ in 0..warmup {
        body();
    }
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let started = Instant::now();
        body();
        samples.push(u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX));
    }
    let mut sorted = samples.clone();
    sorted.sort_unstable();
    (samples, sorted[sorted.len() / 2], percentile(&sorted, 95))
}

fn case(
    id: &str,
    class: &'static str,
    warmup: usize,
    iters: usize,
    body: impl FnMut(),
) -> BenchCase {
    let (samples_ns, ns_median, ns_p95) = measure(warmup, iters, body);
    BenchCase {
        id: id.to_owned(),
        lang: "rust",
        class,
        iters,
        ns_median,
        ns_p95,
        warmup,
        batch_size: 1,
        timing_mode: "sync-single",
        sample_unit: "ns",
        samples_ns,
        statistic: "single-call",
    }
}

fn live_binding() -> (
    boundary_core::lifecycle::Bound<AppContext, ContextAdmission>,
    ProjectionHandle<ChangeCounter>,
    boundary_core::InteractionId,
) {
    let interaction = require(compile_interaction::<ChangeCounter>());
    let interaction_id = interaction.interaction_id().clone();
    let projection = require(project([require(select(
        "change",
        &interaction,
        ProjectionModes::Direct,
    ))]));
    let handle = require(projection.handles().get("change", &interaction));
    let installed = require(install(
        require(InstallationId::new("host/install/bench-v1")),
        [direct_realization(
            &interaction,
            require(RealizationId::new("host/direct/bench-v1")),
            ContextHandler,
        )],
    ));
    let bound = match bind(&projection, &installed.installation, ContextAdmission) {
        BindResult::Bound(binding) => *binding,
        BindResult::Unrealized(unrealized) => fail(format!("{unrealized:?}")),
    };
    (bound, handle, interaction_id)
}

fn schema_scaling_cases(cases: &mut Vec<BenchCase>) {
    let plain_string = require(PortableSchema::from_value(json!({ "type": "string" })));
    for size in [1_024, 1_048_576] {
        let input = Value::String("a".repeat(size));
        cases.push(case(
            &format!("rust.schema.accepts.string.{size}"),
            "per-call",
            40,
            200,
            || {
                if !plain_string.accepts(std::hint::black_box(&input)) {
                    fail("string schema rejected a valid string");
                }
            },
        ));
    }
    let unique_array = require(PortableSchema::from_value(json!({
        "type": "array", "uniqueItems": true
    })));
    for size in [100, 1_000, 5_000] {
        let input = Value::Array((0..size).map(Value::from).collect());
        cases.push(case(
            &format!("rust.schema.accepts.unique.{size}"),
            "per-call",
            3,
            20,
            || {
                if !unique_array.accepts(std::hint::black_box(&input)) {
                    fail("unique array schema rejected distinct integers");
                }
            },
        ));
    }
}

fn main() {
    let mut cases = Vec::new();
    cases.push(case("rust.compile", "startup", 3, 20, || {
        let _ = require(compile_interaction::<ChangeCounter>());
    }));

    cases.push(case("rust.bind", "startup", 3, 20, || {
        let interaction = require(compile_interaction::<ChangeCounter>());
        let projection = require(project([require(select(
            "change",
            &interaction,
            ProjectionModes::Direct,
        ))]));
        let installed = require(install(
            require(InstallationId::new("host/install/bench-bind")),
            [direct_realization(
                &interaction,
                require(RealizationId::new("host/direct/bench-bind")),
                ContextHandler,
            )],
        ));
        match bind(&projection, &installed.installation, admit_all()) {
            BindResult::Bound(_) => {}
            BindResult::Unrealized(unrealized) => fail(format!("{unrealized:?}")),
        }
    }));

    let (bound, handle, interaction_id) = live_binding();
    let context = AppContext;
    cases.push(case("rust.caller.call", "per-call", 40, 400, || {
        let output = require(block_on(bound.binding.caller().call(
            &context,
            &handle,
            ChangeCounter {
                by: "2".to_owned(),
                reject: false,
            },
        )));
        if output != "2" {
            fail("unexpected caller output");
        }
    }));

    let schema = require(PortableSchema::from_value(json!({
        "type": "string",
        "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,31}$"
    })));
    let accepted = Value::String("Ship-Boundary".to_owned());
    cases.push(case(
        "rust.schema.accepts.pattern",
        "per-call",
        80,
        1_000,
        || {
            if !schema.accepts(&accepted) {
                fail("pattern schema rejected a valid string");
            }
        },
    ));

    schema_scaling_cases(&mut cases);

    let handoff = checked_handoff(&bound.binding);
    let invocation = require(HandoffInvocation::new(
        handoff.manifest(),
        &interaction_id,
        InteractionMode::Direct,
        json!({ "by": "2", "reject": false }),
    ));
    cases.push(case("rust.handoff.invoke", "per-call", 20, 120, || {
        let outcome = require(block_on(handoff.invoke(invocation.clone(), &context)));
        if !matches!(outcome.result(), HandoffResult::Returned { .. }) {
            fail("handoff invoke did not return");
        }
    }));

    let payload = serde_json::to_string(&cases).unwrap_or_else(|error| fail(error));
    if let Ok(path) = env::var("PERF_RUST_OUT") {
        if let Err(error) = fs::write(&path, format!("{payload}\n")) {
            fail(error);
        }
    } else {
        println!("{payload}");
    }
}
