//! Deterministic verification helpers for tests and host qualification.

mod crash_matrix;
mod differential;
mod schema_samples;

pub use crash_matrix::{
    ControlCrashPoint, CrashCaseReport, CrashMatrixReport, default_crash_points, run_crash_matrix,
};
pub use differential::{DifferentialMismatch, DifferentialReport, check_observed_read_equivalence};
pub use schema_samples::{
    SchemaSampleReport, check_schema_samples, generate_invalid_samples, generate_valid_samples,
};
