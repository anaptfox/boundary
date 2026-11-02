//! One exact interaction through request, approval, grant, fenced apply, and receipt.

use std::error::Error;

use boundary_core::control::{
    Actor, AllowAll, ApplyFailure, ApplyPermit, ApplyResult, ApprovalDecision, ControlFault,
    ControlInteractionRef, ControlOutcome, ControlledEffect, ControlledHandler, DeterministicIds,
    DurationMillis, InMemoryControlStore, InteractionIdempotencyKey, ManualClock, NormalizedInput,
    ReconcileContext, Reconciliation, Verification,
};
use boundary_core::{Interaction, Program};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.create", output = Created, changes("todos"))]
/// Create one todo under explicit authority.
struct CreateTodo {
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Created {
    id: String,
}

struct CreateEffect {
    applied: bool,
    apply_calls: usize,
    result: ApplyResult,
    unknown: ControlFault,
}

impl ControlledEffect for CreateEffect {
    type ApplyError = ControlFault;
    type VerifyError = ControlFault;
    type ReconcileError = ControlFault;

    fn apply(
        &mut self,
        _input: &NormalizedInput,
        permit: ApplyPermit,
    ) -> Result<ApplyResult, ApplyFailure<Self::ApplyError>> {
        let _fence_reaching_the_mutation = permit.fence();
        self.apply_calls += 1;
        self.applied = true;
        Ok(self.result.clone())
    }

    fn verify(
        &mut self,
        _input: &NormalizedInput,
        _applied: &ApplyResult,
    ) -> Result<Verification, Self::VerifyError> {
        if self.applied {
            Ok(Verification::Completed)
        } else {
            Ok(Verification::Uncertain(self.unknown.clone()))
        }
    }

    fn reconcile(
        &mut self,
        _input: &NormalizedInput,
        _context: ReconcileContext<'_>,
    ) -> Result<Reconciliation, Self::ReconcileError> {
        if self.applied {
            Ok(Reconciliation::Applied(self.result.clone()))
        } else {
            Ok(Reconciliation::Uncertain(self.unknown.clone()))
        }
    }
}

fn duration(millis: u64) -> Result<DurationMillis, Box<dyn Error>> {
    Ok(DurationMillis::new(millis)?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let program = Program::builder().include::<CreateTodo>()?.finish()?;
    let descriptor = program
        .interactions()
        .first()
        .ok_or("program unexpectedly had no interactions")?;
    let interaction = ControlInteractionRef::new(
        descriptor.contract().id().as_str(),
        descriptor.contract_digest().to_string(),
    )?;

    let clock = ManualClock::new(1_000);
    let mut control = ControlledHandler::new(
        interaction,
        InMemoryControlStore::default(),
        clock,
        DeterministicIds::new("example")?,
        AllowAll,
    );
    let input = NormalizedInput::new(
        "application/json",
        br#"{"title":"Controlled Rust interaction"}"#.to_vec(),
    )?;
    let proposal = control.request(input, Actor::new("requester")?, duration(10_000)?)?;
    let approval = control.approve(
        proposal.id(),
        ApprovalDecision::Approved,
        Actor::new("approver")?,
        duration(9_000)?,
    )?;
    let grant = control.grant(approval.id(), Actor::new("grantor")?, duration(8_000)?)?;

    let mut effect = CreateEffect {
        applied: false,
        apply_calls: 0,
        result: ApplyResult::new(
            br#"{"id":"todo-controlled"}"#.to_vec(),
            b"observed todo-controlled".to_vec(),
        )?,
        unknown: ControlFault::new("todo.unknown", "todo state could not be observed")?,
    };
    let key = InteractionIdempotencyKey::new("create-controlled")?;
    let first = control.execute(
        grant.id(),
        key.clone(),
        Actor::new("executor-a")?,
        duration(100)?,
        &mut effect,
    )?;
    let replay = control.execute(
        grant.id(),
        key,
        Actor::new("executor-b")?,
        duration(100)?,
        &mut effect,
    )?;

    assert!(matches!(first, ControlOutcome::Completed(_)));
    assert!(matches!(replay, ControlOutcome::Completed(_)));
    assert_eq!(effect.apply_calls, 1, "receipt replay must not reapply");
    println!(
        "completed: attempts={} receipts={} apply_calls={}",
        control.store().attempt_count(),
        control.store().receipt_count(),
        effect.apply_calls
    );
    Ok(())
}
