use std::fmt::Display;

use super::{AttemptId, ControlError, ControlFault, ControlOutcome, ReceiptRecord};

pub(super) fn live_uncertain(
    attempt_id: AttemptId,
    previous: Option<ReceiptRecord>,
) -> ControlOutcome {
    ControlOutcome::Uncertain {
        attempt_id,
        receipt: previous,
        fault: ControlFault::internal("executor_live", "another executor owns a live lease"),
    }
}

pub(super) fn journal_uncertain(attempt_id: AttemptId) -> ControlOutcome {
    ControlOutcome::Uncertain {
        attempt_id,
        receipt: None,
        fault: ControlFault::internal(
            "receipt_not_committed",
            "the outcome could not be committed under the active fence",
        ),
    }
}

pub(super) fn store_error(error: impl Display) -> ControlError {
    ControlError::Store(error.to_string())
}

pub(super) fn policy_error(error: impl Display) -> ControlError {
    ControlError::Policy(error.to_string())
}
