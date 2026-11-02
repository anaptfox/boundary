#![doc = "Controlled-effect lifecycle and recovery conformance tests."]

mod control_support;

use std::{error::Error, io};

use boundary_core::control::{
    Actor, AllowAll, ApplyResult, ApprovalDecision, ApprovalRecord, AttemptRecord, ControlError,
    ControlInteractionRef, ControlOutcome, ControlPolicy, ControlledHandler, DurationMillis,
    GrantRecord, InteractionIdempotencyKey, ProposalRecord, ReceiptOutcome, ReceiptRecord,
};
use control_support::{
    ApplyMode, Handler, ReconcileMode, TestClock, TestEffect, VerifyMode, actor, fault, input,
    interaction, key, policy_handler,
};

struct DenyExecute;

impl ControlPolicy for DenyExecute {
    type Error = io::Error;

    fn request(&self, _proposal: &ProposalRecord) -> Result<(), Self::Error> {
        Ok(())
    }
    fn approve(
        &self,
        _proposal: &ProposalRecord,
        _approval: &ApprovalRecord,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    fn grant(
        &self,
        _proposal: &ProposalRecord,
        _approval: &ApprovalRecord,
        _grant: &GrantRecord,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    fn execute(
        &self,
        _proposal: &ProposalRecord,
        _grant: &GrantRecord,
        _owner: &Actor,
        _idempotency_key: &InteractionIdempotencyKey,
    ) -> Result<(), Self::Error> {
        Err(io::Error::other("executor denied"))
    }
    fn reconcile(
        &self,
        _attempt: &AttemptRecord,
        _previous: Option<&ReceiptRecord>,
        _owner: &Actor,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

fn duration(millis: u64) -> Result<DurationMillis, ControlError> {
    DurationMillis::new(millis)
}

fn ready(clock: TestClock) -> Result<(Handler, GrantRecord), ControlError> {
    let mut handler = policy_handler(AllowAll, clock)?;
    let proposal = handler.request(input()?, actor("requester")?, duration(100_000)?)?;
    let approval = handler.approve(
        proposal.id(),
        ApprovalDecision::Approved,
        actor("approver")?,
        duration(90_000)?,
    )?;
    let grant = handler.grant(approval.id(), actor("grantor")?, duration(80_000)?)?;
    Ok((handler, grant))
}

fn completed_effect() -> Result<TestEffect, ControlError> {
    let applied = ApplyResult::new(br#"{"id":"todo-1"}"#.to_vec(), b"proof".to_vec())?;
    Ok(TestEffect {
        apply_calls: 0,
        verify_calls: 0,
        reconcile_calls: 0,
        fences: Vec::new(),
        apply_mode: ApplyMode::Applied(applied.clone()),
        verify_mode: VerifyMode::Completed,
        reconcile_mode: ReconcileMode::Applied(applied),
    })
}

#[test]
fn completed_attempt_replays_receipt_without_reapplying() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (mut handler, grant) = ready(clock)?;
    let mut effect = completed_effect()?;

    let first = handler.execute(
        grant.id(),
        key("create-1")?,
        actor("executor-a")?,
        duration(100)?,
        &mut effect,
    )?;
    let second = handler.execute(
        grant.id(),
        key("create-1")?,
        actor("executor-b")?,
        duration(100)?,
        &mut effect,
    )?;

    assert!(matches!(first, ControlOutcome::Completed(_)));
    assert!(matches!(second, ControlOutcome::Completed(_)));
    assert_eq!(
        effect.apply_calls, 1,
        "an idempotent replay must not receive a second permit"
    );
    assert_eq!(
        effect.reconcile_calls, 0,
        "a terminal receipt needs no recovery"
    );
    assert_eq!(effect.fences.len(), 1);
    Ok(())
}

#[test]
fn classified_apply_failure_is_durably_not_applied() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (mut handler, grant) = ready(clock)?;
    let applied = ApplyResult::new(Vec::new(), Vec::new())?;
    let mut effect = TestEffect {
        apply_calls: 0,
        verify_calls: 0,
        reconcile_calls: 0,
        fences: Vec::new(),
        apply_mode: ApplyMode::NotApplied(fault("remote_rejected")?),
        verify_mode: VerifyMode::Completed,
        reconcile_mode: ReconcileMode::Applied(applied),
    };

    let outcome = handler.execute(
        grant.id(),
        key("create-2")?,
        actor("executor")?,
        duration(100)?,
        &mut effect,
    )?;

    assert!(matches!(outcome, ControlOutcome::NotApplied(_)));
    assert_eq!(effect.apply_calls, 1);
    assert_eq!(effect.verify_calls, 0);
    Ok(())
}

#[test]
fn live_executor_blocks_recovery_then_stale_lease_is_fenced() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (mut handler, grant) = ready(clock.clone())?;
    let applied = ApplyResult::new(b"done".to_vec(), b"evidence".to_vec())?;
    let mut effect = TestEffect {
        apply_calls: 0,
        verify_calls: 0,
        reconcile_calls: 0,
        fences: Vec::new(),
        apply_mode: ApplyMode::Applied(applied.clone()),
        verify_mode: VerifyMode::Failed(fault("verify_transport")?),
        reconcile_mode: ReconcileMode::Applied(applied),
    };

    let uncertain = handler.execute(
        grant.id(),
        key("create-3")?,
        actor("executor-a")?,
        duration(100)?,
        &mut effect,
    )?;
    let (attempt_id, first_receipt) = match uncertain {
        ControlOutcome::Uncertain {
            attempt_id,
            receipt,
            ..
        } => (attempt_id, receipt),
        other => return Err(format!("expected uncertain outcome, got {other:?}").into()),
    };
    assert!(first_receipt.is_some());
    let live = handler.reconcile(
        &attempt_id,
        actor("executor-b")?,
        duration(100)?,
        &mut effect,
    )?;
    assert!(matches!(live, ControlOutcome::Uncertain { .. }));
    assert_eq!(
        effect.reconcile_calls, 0,
        "a live executor must not be preempted"
    );

    clock.set(1_101);
    effect.verify_mode = VerifyMode::Completed;
    let recovered = handler.reconcile(
        &attempt_id,
        actor("executor-b")?,
        duration(100)?,
        &mut effect,
    )?;
    let receipt = match recovered {
        ControlOutcome::Completed(receipt) => receipt,
        other => return Err(format!("expected completed recovery, got {other:?}").into()),
    };

    assert!(receipt.reconciled());
    assert_eq!(
        effect.apply_calls, 1,
        "reconciliation must never call apply"
    );
    assert_eq!(effect.reconcile_calls, 1);
    assert!(receipt.fence().get() > effect.fences[0].get());
    Ok(())
}

#[test]
fn uncertain_apply_can_reconcile_to_not_applied_without_replay() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (mut handler, grant) = ready(clock.clone())?;
    let mut effect = TestEffect {
        apply_calls: 0,
        verify_calls: 0,
        reconcile_calls: 0,
        fences: Vec::new(),
        apply_mode: ApplyMode::Uncertain(fault("connection_lost")?),
        verify_mode: VerifyMode::Completed,
        reconcile_mode: ReconcileMode::NotApplied(fault("remote_absent")?),
    };
    let initial = handler.execute(
        grant.id(),
        key("create-4")?,
        actor("executor-a")?,
        duration(50)?,
        &mut effect,
    )?;
    let attempt_id = match initial {
        ControlOutcome::Uncertain { attempt_id, .. } => attempt_id,
        other => return Err(format!("expected uncertain outcome, got {other:?}").into()),
    };

    clock.set(1_051);
    let recovered = handler.reconcile(
        &attempt_id,
        actor("executor-b")?,
        duration(50)?,
        &mut effect,
    )?;
    assert!(matches!(recovered, ControlOutcome::NotApplied(_)));
    assert_eq!(effect.apply_calls, 1);
    assert_eq!(effect.reconcile_calls, 1);
    Ok(())
}

#[test]
fn expired_and_mismatched_authority_never_reaches_apply() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (handler, grant) = ready(clock.clone())?;
    let (_configured, store, host_clock, ids, policy) = handler.into_parts();
    let wrong = ControlInteractionRef::new("todos.delete", "sha256:other")?;
    let mut mismatched = ControlledHandler::new(wrong, store, host_clock, ids, policy);
    let mut effect = completed_effect()?;
    let mismatch = mismatched.execute(
        grant.id(),
        key("create-5")?,
        actor("executor")?,
        duration(100)?,
        &mut effect,
    );
    assert!(matches!(mismatch, Err(ControlError::AuthorityMismatch(_))));
    assert_eq!(effect.apply_calls, 0);

    let (_wrong, store, host_clock, ids, policy) = mismatched.into_parts();
    let mut restored = ControlledHandler::new(interaction()?, store, host_clock, ids, policy);
    clock.set(100_001);
    let expired = restored.execute(
        grant.id(),
        key("create-6")?,
        actor("executor")?,
        duration(100)?,
        &mut effect,
    );
    assert!(matches!(
        expired,
        Err(ControlError::AuthorityExpired { .. })
    ));
    assert_eq!(effect.apply_calls, 0);
    Ok(())
}

#[test]
fn durable_receipt_classification_matches_public_outcome() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let (mut handler, grant) = ready(clock)?;
    let mut effect = completed_effect()?;
    let outcome = handler.execute(
        grant.id(),
        key("create-7")?,
        actor("executor")?,
        duration(100)?,
        &mut effect,
    )?;
    let receipt = match outcome {
        ControlOutcome::Completed(receipt) => receipt,
        other => return Err(format!("expected completed outcome, got {other:?}").into()),
    };
    assert!(
        matches!(receipt.outcome(), ReceiptOutcome::Completed { output } if output == br#"{"id":"todo-1"}"#)
    );
    Ok(())
}

#[test]
fn execute_policy_denial_happens_before_attempt_and_apply() -> Result<(), Box<dyn Error>> {
    let clock = TestClock::new(1_000);
    let mut handler = policy_handler(DenyExecute, clock)?;
    let proposal = handler.request(input()?, actor("requester")?, duration(100_000)?)?;
    let approval = handler.approve(
        proposal.id(),
        ApprovalDecision::Approved,
        actor("approver")?,
        duration(90_000)?,
    )?;
    let grant = handler.grant(approval.id(), actor("grantor")?, duration(80_000)?)?;
    let mut effect = completed_effect()?;

    let outcome = handler.execute(
        grant.id(),
        key("policy-denied")?,
        actor("executor")?,
        duration(100)?,
        &mut effect,
    );

    assert!(matches!(outcome, Err(ControlError::Policy(_))));
    assert_eq!(effect.apply_calls, 0);
    assert!(handler.store().attempts.is_empty());
    Ok(())
}

#[test]
fn reviewed_recovery_traces_preserve_apply_suppression() -> Result<(), Box<dyn Error>> {
    let evidence: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/control-recovery.json"
    ))?;
    let cases = evidence["cases"]
        .as_array()
        .ok_or("missing recovery cases")?;
    for case in cases {
        let clock = TestClock::new(1_000);
        let (mut handler, grant) = ready(clock.clone())?;
        let mut effect = completed_effect()?;
        if case["loseEffectResponse"] == true {
            effect.apply_mode = ApplyMode::Uncertain(fault("effect_response_lost")?);
        }
        let initial = handler.execute(
            grant.id(),
            key("trace")?,
            actor("executor")?,
            duration(50)?,
            &mut effect,
        )?;
        let classify = |outcome: &ControlOutcome| match outcome {
            ControlOutcome::Completed(_) => "completed",
            ControlOutcome::NotApplied(_) => "not-applied",
            ControlOutcome::Uncertain { .. } => "uncertain",
        };
        assert_eq!(case["initial"], classify(&initial), "{}", case["id"]);
        let replay = handler.execute(
            grant.id(),
            key("trace")?,
            actor("executor")?,
            duration(50)?,
            &mut effect,
        )?;
        assert_eq!(case["replay"], classify(&replay), "{}", case["id"]);
        clock.set(1_051);
        let recovered = match initial {
            ControlOutcome::Uncertain { attempt_id, .. } => handler.reconcile(
                &attempt_id,
                actor("reconciler")?,
                duration(50)?,
                &mut effect,
            )?,
            terminal => terminal,
        };
        assert_eq!(
            case["afterLeaseExpiry"],
            classify(&recovered),
            "{}",
            case["id"]
        );
        assert_eq!(case["applyCalls"], effect.apply_calls, "{}", case["id"]);
    }
    Ok(())
}
