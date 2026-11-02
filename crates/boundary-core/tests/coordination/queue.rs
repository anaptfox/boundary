use super::{Context, Echo, EchoHandler, Policy, bound};
use boundary_core::{
    handoff::HandoffResult,
    lifecycle::{
        CoordinatedInvocation, CoordinationError, CoordinationFuture, InstallationId,
        InvocationCertainty, InvocationContinuation, InvocationCoordinator, ProjectionModes,
        RealizationId, bind, compile_interaction, coordinate_binding, direct_realization, install,
        project, select,
    },
};
use futures::{channel::oneshot, executor::block_on, task::noop_waker_ref};
use serde_json::json;
use std::{
    error::Error,
    future::Future,
    pin::pin,
    sync::{Mutex, atomic::Ordering},
    task::{Context as TaskContext, Poll},
};

struct QueuedCoordinator {
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    retained: bool,
}
impl InvocationCoordinator<Context> for QueuedCoordinator {
    fn coordinate<'a>(
        &'a self,
        request: CoordinatedInvocation<'a, Context>,
        proceed: InvocationContinuation<'a>,
    ) -> CoordinationFuture<'a> {
        Box::pin(async move {
            request.context().hooks.fetch_add(1, Ordering::SeqCst);
            let gate = self
                .gate
                .lock()
                .map_err(|_| CoordinationError)?
                .take()
                .ok_or(CoordinationError)?;
            gate.await.map_err(|_| CoordinationError)?;
            if self.retained {
                request
                    .outcome(
                        InvocationCertainty::Completed,
                        HandoffResult::Returned {
                            value: json!("retained"),
                        },
                    )
                    .map_err(|_| CoordinationError)
            } else {
                proceed.proceed().await
            }
        })
    }
}

#[test]
fn revocation_while_coordinator_is_pending_refuses_dispatch_and_retained_disclosure()
-> Result<(), Box<dyn Error>> {
    for retained in [false, true] {
        let echo = compile_interaction::<Echo>()?;
        let projection = project([select("echo", &echo, ProjectionModes::Direct)?])?;
        let installed = install(
            InstallationId::new("coordination:queue")?,
            [direct_realization(
                &echo,
                RealizationId::new("coordination:queue-direct")?,
                EchoHandler,
            )],
        )?;
        let (send, receive) = oneshot::channel();
        let bound = coordinate_binding(
            *bound(bind(&projection, &installed.installation, Policy))?,
            QueuedCoordinator {
                gate: Mutex::new(Some(receive)),
                retained,
            },
        )?;
        let context = Context::new(true);
        context
            .address
            .store(std::ptr::from_ref(&context).addr(), Ordering::SeqCst);
        let handle = projection.handles().get("echo", &echo)?;
        let caller = bound.binding.caller();
        let mut future = pin!(caller.call(
            &context,
            &handle,
            Echo {
                value: "fresh".into()
            }
        ));
        let mut task = TaskContext::from_waker(noop_waker_ref());
        assert!(matches!(future.as_mut().poll(&mut task), Poll::Pending));
        assert_eq!(context.hooks.load(Ordering::SeqCst), 1);
        assert!(bound.controller.revoke());
        send.send(()).map_err(|()| "closed coordinator gate")?;
        let error = block_on(future)
            .err()
            .ok_or("revoked request unexpectedly dispatched")?;
        assert_eq!(error.certainty(), InvocationCertainty::NotStarted);
        assert_eq!(context.dispatches.load(Ordering::SeqCst), 0);
    }
    Ok(())
}
