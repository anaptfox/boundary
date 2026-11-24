//! Tests for the optional public verification harness.
#![allow(clippy::expect_used)]

use std::cell::Cell;

use boundary_core::{
    PortableSchema,
    testing::{
        ControlCrashPoint, check_observed_read_equivalence, check_schema_samples,
        default_crash_points, run_crash_matrix,
    },
};
use serde_json::json;

#[test]
fn schema_samples_cover_valid_and_invalid_boundaries() {
    let schema = PortableSchema::from_value(json!({
        "type":"object", "properties":{"name":{"type":"string","minLength":2},"age":{"type":"integer","minimum":1}},
        "required":["name","age"], "additionalProperties":false
    })).expect("schema should compile");
    let report = check_schema_samples(&schema, 16);
    assert!(report.valid_checked > 0, "{report:?}");
    assert!(report.invalid_checked > 0, "{report:?}");
    assert!(report.failures.is_empty(), "{report:?}");
}

#[test]
fn differential_check_accepts_equal_and_reports_stale_values() {
    let equal =
        check_observed_read_equivalence(3, |_| (json!({"a":1,"b":2}), json!({"b":2,"a":1})));
    assert!(equal.is_ok());
    assert_eq!(equal.reads_checked, 3);

    let stale = check_observed_read_equivalence(3, |index| (json!(index), json!(index + 1)));
    assert!(!stale.is_ok());
    assert_eq!(
        stale
            .mismatches
            .iter()
            .map(|mismatch| mismatch.step_index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
}

#[test]
fn crash_matrix_executes_each_control_boundary() {
    let count = Cell::new(0);
    let report = run_crash_matrix(|point| {
        count.set(count.get() + 1);
        Ok(format!("recovered at {point:?}"))
    });
    assert!(report.is_ok());
    assert_eq!(count.get(), 3);
    assert_eq!(
        report
            .cases
            .iter()
            .map(|case| case.point)
            .collect::<Vec<_>>(),
        default_crash_points()
    );
    assert_eq!(
        default_crash_points(),
        [
            ControlCrashPoint::AfterAttempt,
            ControlCrashPoint::AfterApply,
            ControlCrashPoint::AfterVerify
        ]
    );
}
