#![doc = "Conformance tests for feature-gated control host utilities."]
#![cfg(feature = "test-util")]

use std::error::Error;

use boundary_core::control::{
    Clock, DeterministicIds, DurationMillis, IdKind, IdSource, InMemoryControlStore, ManualClock,
};

#[test]
fn manual_clock_advances_atomically() -> Result<(), Box<dyn Error>> {
    let clock = ManualClock::new(1_000);
    let now = clock.advance(DurationMillis::new(25)?)?;

    assert_eq!(now.as_millis(), 1_025);
    assert_eq!(clock.now()?.as_millis(), 1_025);
    Ok(())
}

#[test]
fn deterministic_ids_and_empty_store_are_example_ready() -> Result<(), Box<dyn Error>> {
    let mut ids = DeterministicIds::new("example")?;
    assert_eq!(ids.next_id(IdKind::Proposal)?, "example-Proposal-1");
    assert_eq!(ids.next_id(IdKind::Attempt)?, "example-Attempt-2");

    let store = InMemoryControlStore::default();
    assert_eq!(store.attempt_count(), 0);
    assert_eq!(store.receipt_count(), 0);
    Ok(())
}
