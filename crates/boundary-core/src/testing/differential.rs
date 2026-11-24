use serde_json::Value;

use crate::canonical_json;

/// A cached and fresh observation that differ under canonical JSON equality.
#[derive(Clone, Debug, PartialEq)]
pub struct DifferentialMismatch {
    /// Index of the read step that differed.
    pub step_index: usize,
    /// Value returned by the cached or reused read.
    pub cached: Value,
    /// Value returned by the fresh read.
    pub fresh: Value,
}

/// Results from checking cached and fresh observed reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DifferentialReport {
    /// Number of read pairs compared.
    pub reads_checked: usize,
    /// Every pair that differed or could not be canonicalized.
    pub mismatches: Vec<DifferentialMismatch>,
}

impl DifferentialReport {
    /// Returns whether every compared read was equivalent.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// Compares cached/reused and fresh values for each requested read step.
///
/// Values are equivalent when their canonical JSON encodings are equal.
pub fn check_observed_read_equivalence<F>(steps: usize, mut compare: F) -> DifferentialReport
where
    F: FnMut(usize) -> (Value, Value),
{
    let mut report = DifferentialReport::default();
    for step_index in 0..steps {
        let (cached, fresh) = compare(step_index);
        report.reads_checked += 1;
        let equivalent = match (canonical_json(&cached), canonical_json(&fresh)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        };
        if !equivalent {
            report.mismatches.push(DifferentialMismatch {
                step_index,
                cached,
                fresh,
            });
        }
    }
    report
}
