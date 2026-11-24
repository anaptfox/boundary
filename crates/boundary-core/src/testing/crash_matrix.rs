/// A durable-control crash boundary to qualify.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlCrashPoint {
    /// Crash after recording the attempt and before applying effects.
    AfterAttempt,
    /// Crash after applying effects and before verification.
    AfterApply,
    /// Crash after verification and before final receipt commit.
    AfterVerify,
}

/// Outcome of running one crash boundary case.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrashCaseReport {
    /// Boundary at which the test injected a crash.
    pub point: ControlCrashPoint,
    /// Whether the runner recovered according to its assertions.
    pub recovered: bool,
    /// Runner-provided summary or error detail.
    pub detail: String,
}

/// Outcomes for a complete control crash matrix.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CrashMatrixReport {
    /// One result per requested crash boundary.
    pub cases: Vec<CrashCaseReport>,
}

impl CrashMatrixReport {
    /// Returns whether all crash cases recovered successfully.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.cases.iter().all(|case| case.recovered)
    }
}

/// Returns the supported control crash boundaries in execution order.
#[must_use]
pub const fn default_crash_points() -> [ControlCrashPoint; 3] {
    [
        ControlCrashPoint::AfterAttempt,
        ControlCrashPoint::AfterApply,
        ControlCrashPoint::AfterVerify,
    ]
}

/// Runs `run_case` once at each supported control crash boundary.
pub fn run_crash_matrix<F>(mut run_case: F) -> CrashMatrixReport
where
    F: FnMut(ControlCrashPoint) -> Result<String, String>,
{
    CrashMatrixReport {
        cases: default_crash_points()
            .into_iter()
            .map(|point| match run_case(point) {
                Ok(detail) => CrashCaseReport {
                    point,
                    recovered: true,
                    detail,
                },
                Err(detail) => CrashCaseReport {
                    point,
                    recovered: false,
                    detail,
                },
            })
            .collect(),
    }
}
