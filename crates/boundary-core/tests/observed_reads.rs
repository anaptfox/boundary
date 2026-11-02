//! Native execution, mutation, and independently reviewed observation evidence.

#[path = "observations/support.rs"]
mod support;

use std::{collections::BTreeMap, error::Error, sync::atomic::Ordering};

use boundary_core::{
    lifecycle::CallerError,
    observations::{ObservedReadOptions, ReadReuse},
};
use futures::executor::block_on;
use serde::Deserialize;
use serde_json::{Value, json};
use support::*;

fn reuse() -> ObservedReadOptions {
    ObservedReadOptions {
        reuse: ReadReuse::Validated,
        ..Default::default()
    }
}

#[derive(Deserialize)]
struct Fixture {
    version: usize,
    points: Vec<PointCase>,
    queries: Vec<QueryCase>,
}
#[derive(Deserialize)]
struct PointCase {
    name: String,
    key: String,
    source: BTreeMap<String, Value>,
    target: BTreeMap<String, Value>,
    expected: String,
}
#[derive(Deserialize)]
struct QueryCase {
    name: String,
    query: Query,
    source: Vec<Row>,
    target: Vec<Row>,
    expected: String,
}

#[test]
fn reviewed_point_and_query_evidence_runs_through_native_installation() -> Result<(), Box<dyn Error>>
{
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/observed-reads.json"
    ))?;
    assert_eq!(fixture.version, 1);
    for (index, case) in fixture.points.into_iter().enumerate() {
        let rig = Rig::new(
            Data {
                points: case.source,
                ..Default::default()
            },
            reuse(),
            &format!("point/{index}"),
        )?;
        rig.call(point(&case.key), 0)?;
        let target = case.target;
        rig.replace(Data {
            points: target.clone(),
            ..Default::default()
        })?;
        let output = rig.call(point(&case.key), 0)?;
        assert_eq!(
            output.point,
            target.get(&case.key).cloned(),
            "{}",
            case.name
        );
        assert_eq!(
            rig.last_reused()?,
            case.expected == "matching",
            "{}",
            case.name
        );
    }
    for (index, case) in fixture.queries.into_iter().enumerate() {
        let rig = Rig::new(
            Data {
                rows: case.source,
                ..Default::default()
            },
            reuse(),
            &format!("query/{index}"),
        )?;
        rig.call(query(case.query.clone()), 0)?;
        rig.replace(Data {
            rows: case.target.clone(),
            ..Default::default()
        })?;
        let output = rig.call(query(case.query.clone()), 0)?;
        assert_eq!(
            output.rows,
            query_rows(&case.target, &case.query),
            "{}",
            case.name
        );
        assert_eq!(
            rig.last_reused()?,
            case.expected == "matching",
            "{}",
            case.name
        );
    }
    Ok(())
}

#[test]
fn fresh_authorization_input_scope_and_realization_remain_separate() -> Result<(), Box<dyn Error>> {
    let rig = Rig::new(
        Data {
            points: BTreeMap::from([("a".to_owned(), json!(1)), ("b".to_owned(), json!(2))]),
            ..Default::default()
        },
        reuse(),
        "isolation",
    )?;
    rig.call(point("a"), 0)?;
    rig.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 1);
    rig.call(point("a"), 1)?;
    rig.call(point("b"), 0)?;
    assert_eq!(rig.evaluations(), 3);
    let denied = block_on(rig.bound.binding.caller().call(
        &Context {
            scope: 0,
            allow: false,
        },
        &rig.handle,
        point("a"),
    ));
    assert!(matches!(denied, Err(CallerError::Denied { code }) if code == "host.denied"));
    assert_eq!(rig.evaluations(), 3);
    assert_eq!(rig.stats.authorizations.load(Ordering::SeqCst), 5);
    let replacement = Rig::with_shared(
        rig.source.clone(),
        rig.stats.clone(),
        reuse(),
        "replacement",
    )?;
    replacement.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 4);
    assert!(rig.controller.revoke());
    assert!(matches!(rig.call(point("a"), 0), Err(CallerError::Revoked)));
    replacement.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 4);
    Ok(())
}

#[test]
fn installation_revocation_releases_retained_output_with_the_binding_still_alive()
-> Result<(), Box<dyn Error>> {
    let rig = Rig::new(Data::default(), reuse(), "release-retained")?;
    let output = rig.call(point("a"), 0)?;
    assert_eq!(std::sync::Arc::strong_count(&output.retention), 3);
    drop(output);
    assert_eq!(std::sync::Arc::strong_count(&rig.stats.retention), 2);
    assert!(rig.controller.revoke());
    assert_eq!(std::sync::Arc::strong_count(&rig.stats.retention), 1);
    assert!(matches!(rig.call(point("a"), 0), Err(CallerError::Revoked)));
    Ok(())
}

#[test]
fn a_snapshot_failure_after_evaluation_does_not_retain_its_successful_output()
-> Result<(), Box<dyn Error>> {
    let rig = Rig::new(
        Data {
            after_callback_failure: true,
            ..Default::default()
        },
        reuse(),
        "boundary-failure",
    )?;
    assert!(matches!(rig.call(point("a"), 0), Err(CallerError::Unknown)));
    assert!(matches!(rig.call(point("a"), 0), Err(CallerError::Unknown)));
    assert_eq!(rig.evaluations(), 2);
    assert_eq!(std::sync::Arc::strong_count(&rig.stats.retention), 1);
    rig.replace(Data::default())?;
    rig.call(point("a"), 0)?;
    assert!(!rig.last_reused()?);
    assert_eq!(rig.evaluations(), 3);
    rig.call(point("a"), 0)?;
    assert!(rig.last_reused()?);
    assert_eq!(rig.evaluations(), 3);
    Ok(())
}

#[test]
fn selector_reads_and_owned_output_prevent_stale_or_mutated_reuse() -> Result<(), Box<dyn Error>> {
    let mut data = Data {
        points: BTreeMap::from([
            ("selector".to_owned(), json!("a")),
            ("a".to_owned(), json!({"value": 1})),
            ("b".to_owned(), json!({"value": 2})),
        ]),
        ..Default::default()
    };
    let rig = Rig::new(data.clone(), reuse(), "selector")?;
    let read = Read {
        key: None,
        query: None,
        selector: Some("selector".to_owned()),
    };
    let mut returned = rig.call(read.clone(), 0)?;
    returned.point = Some(json!("caller mutation"));
    assert_eq!(rig.call(read.clone(), 0)?.point, Some(json!({"value": 1})));
    assert_eq!(rig.evaluations(), 1);
    data.points.insert("selector".to_owned(), json!("b"));
    rig.replace(data)?;
    assert_eq!(rig.call(read, 0)?.point, Some(json!({"value": 2})));
    assert_eq!(rig.evaluations(), 2);
    Ok(())
}

#[test]
fn unavailable_validation_evaluates_fresh_but_read_failures_and_invalid_output_do_not_cache()
-> Result<(), Box<dyn Error>> {
    let mut data = Data {
        points: BTreeMap::from([("a".to_owned(), json!(1))]),
        ..Default::default()
    };
    let rig = Rig::new(data.clone(), reuse(), "failures")?;
    rig.call(point("a"), 0)?;
    data.unavailable = true;
    rig.replace(data.clone())?;
    rig.call(point("a"), 0)?;
    rig.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 3);
    data.unavailable = false;
    data.invalid_validation = true;
    rig.replace(data.clone())?;
    rig.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 4);
    data.invalid_reads = true;
    rig.replace(data.clone())?;
    assert_eq!(rig.call(point("missing"), 0)?.point, None);
    assert!(!rig.last_reused()?);
    assert_eq!(rig.call(point("missing"), 0)?.point, None);
    assert!(!rig.last_reused()?);
    data.invalid_reads = false;
    data.invalid_validation = false;
    rig.replace(data)?;
    rig.stats.invalid_output.store(true, Ordering::SeqCst);
    assert!(matches!(
        rig.call(point("missing"), 0),
        Err(CallerError::Unknown)
    ));
    rig.stats.invalid_output.store(false, Ordering::SeqCst);
    rig.call(point("missing"), 0)?;
    assert!(!rig.last_reused()?);
    rig.stats.panicking_diagnostic.store(true, Ordering::SeqCst);
    assert_eq!(rig.call(point("missing"), 0)?.point, None);
    Ok(())
}

#[test]
fn handled_read_errors_return_domain_fallback_without_retention() -> Result<(), Box<dyn Error>> {
    let rig = Rig::new(
        Data {
            invalid_reads: true,
            ..Default::default()
        },
        reuse(),
        "fallback",
    )?;
    assert_eq!(rig.call(point("a"), 0)?.point, None);
    assert_eq!(rig.call(point("a"), 0)?.point, None);
    assert_eq!(rig.evaluations(), 2);
    assert_eq!(std::sync::Arc::strong_count(&rig.stats.retention), 1);
    assert!(!rig.last_reused()?);
    rig.replace(Data::default())?;
    rig.call(point("a"), 0)?;
    assert!(!rig.last_reused()?);
    rig.call(point("a"), 0)?;
    assert!(rig.last_reused()?);
    assert_eq!(rig.evaluations(), 3);
    Ok(())
}

#[test]
fn reuse_defaults_off_and_fifo_eviction_does_not_refresh_on_hits() -> Result<(), Box<dyn Error>> {
    let rig = Rig::new(
        Data::default(),
        ObservedReadOptions::default(),
        "default-off",
    )?;
    rig.call(point("a"), 0)?;
    rig.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 2);
    let rig = Rig::new(
        Data::default(),
        ObservedReadOptions {
            max_entries: 2,
            ..reuse()
        },
        "fifo",
    )?;
    rig.call(point("a"), 0)?;
    rig.call(point("b"), 0)?;
    rig.call(point("a"), 0)?;
    rig.call(point("c"), 0)?;
    rig.call(point("a"), 0)?;
    assert_eq!(rig.evaluations(), 4);
    Ok(())
}

#[test]
fn snapshot_and_declared_evaluation_failures_never_become_reused_successes()
-> Result<(), Box<dyn Error>> {
    let rig = Rig::new(
        Data {
            snapshot_failure: true,
            ..Default::default()
        },
        reuse(),
        "source-failure",
    )?;
    assert!(matches!(rig.call(point("a"), 0), Err(CallerError::Unknown)));
    assert_eq!(rig.evaluations(), 0);
    rig.replace(Data::default())?;
    rig.stats.evaluation_failure.store(true, Ordering::SeqCst);
    assert!(matches!(
        rig.call(point("a"), 0),
        Err(CallerError::Declared(_))
    ));
    assert!(matches!(
        rig.call(point("a"), 0),
        Err(CallerError::Declared(_))
    ));
    assert_eq!(rig.evaluations(), 2);
    rig.stats.evaluation_failure.store(false, Ordering::SeqCst);
    rig.call(point("a"), 0)?;
    assert!(!rig.last_reused()?);
    Ok(())
}

#[test]
fn generated_point_and_query_sequences_equal_fresh_evaluation() -> Result<(), Box<dyn Error>> {
    let rig = Rig::new(Data::default(), reuse(), "generated")?;
    for seed in 0..96u32 {
        let data = Data {
            points: (0..4)
                .filter(|key| (seed >> key) & 1 == 1)
                .map(|key| {
                    (
                        format!("key-{key}"),
                        if (seed >> (key + 1)) & 1 == 1 {
                            Value::Null
                        } else {
                            json!(seed % 3)
                        },
                    )
                })
                .collect(),
            rows: (0..4)
                .filter(|id| (seed >> id) & 1 == 1)
                .map(|id| Row {
                    id,
                    title: format!("row-{}", seed % 3),
                    completed: (seed + id) % 2 == 0,
                })
                .collect(),
            ..Default::default()
        };
        rig.replace(data.clone())?;
        for key in 0..4 {
            let key = format!("key-{key}");
            assert_eq!(
                rig.call(point(&key), 0)?.point,
                data.points.get(&key).cloned()
            );
        }
        for offset in 0..3 {
            let descriptor = Query {
                completed: Some(seed % 2 == 0),
                order: "id-asc".to_owned(),
                offset,
                limit: Some(2),
            };
            assert_eq!(
                rig.call(query(descriptor.clone()), 0)?.rows,
                query_rows(&data.rows, &descriptor)
            );
        }
    }
    Ok(())
}

#[test]
fn fresh_oracle_detects_incomplete_point_and_query_validators() -> Result<(), Box<dyn Error>> {
    let rig = Rig::new(Data::default(), reuse(), "negative-points")?;
    rig.call(point("a"), 0)?;
    let data = Data {
        points: BTreeMap::from([("a".to_owned(), json!(null))]),
        incomplete: true,
        ..Default::default()
    };
    rig.replace(data.clone())?;
    assert_ne!(
        rig.call(point("a"), 0)?.point,
        data.points.get("a").cloned()
    );
    let rig = Rig::new(Data::default(), reuse(), "negative-queries")?;
    let descriptor = Query {
        completed: None,
        order: "id-asc".to_owned(),
        offset: 0,
        limit: None,
    };
    rig.call(query(descriptor.clone()), 0)?;
    let data = Data {
        rows: vec![Row {
            id: 1,
            title: "phantom".to_owned(),
            completed: false,
        }],
        incomplete: true,
        ..Default::default()
    };
    rig.replace(data.clone())?;
    assert_ne!(
        rig.call(query(descriptor.clone()), 0)?.rows,
        query_rows(&data.rows, &descriptor)
    );
    Ok(())
}
