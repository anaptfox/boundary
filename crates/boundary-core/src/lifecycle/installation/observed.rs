use std::{any::TypeId, future::Future, marker::PhantomData, pin::Pin, sync::Arc};

use crate::{
    DeclaredErrorCodec, Interaction, PortableFault, ReadOnly, WireCodec,
    lifecycle::CompiledInteraction,
    observations::{
        ObservationFault, ObservedExecutor, ObservedReadOptions, ReadEvaluator, ReadFailure,
        SnapshotSource,
    },
};

use super::{
    InstallationContribution, RealizationId,
    adapter::{
        ContributionKind, DirectInputKind, DynamicDirect, InstallationCallFault, InstallationInput,
        InstallationOutcome,
    },
};

struct ObservedDirect<O, C: Sync + ?Sized, Source, Eval>
where
    O: Interaction<Effect = ReadOnly>,
    Source: SnapshotSource<C>,
    Eval: ReadEvaluator<O, C, Source::Snapshot>,
{
    executor: ObservedExecutor<O, C, Source, Eval>,
    _context: PhantomData<fn(&C)>,
}

impl<O, C, Source, Eval> DynamicDirect<C> for ObservedDirect<O, C, Source, Eval>
where
    O: Interaction<Effect = ReadOnly> + Clone + Eq + Sync,
    O::Output: Clone,
    C: Sync + ?Sized,
    Source: SnapshotSource<C>,
    Eval: ReadEvaluator<O, C, Source::Snapshot>,
{
    fn input_kind(&self) -> DirectInputKind {
        DirectInputKind::Native(TypeId::of::<O>())
    }

    fn clear_retained(&self) {
        self.executor.close();
    }

    fn call<'a>(
        &'a self,
        context: &'a C,
        input: InstallationInput,
    ) -> Pin<Box<dyn Future<Output = Result<InstallationOutcome, InstallationCallFault>> + Send + 'a>>
    {
        Box::pin(async move {
            let (input, portable) = match input {
                InstallationInput::Native(input) => (
                    *input
                        .downcast::<O>()
                        .map_err(|_| InstallationCallFault::InvalidInput)?,
                    false,
                ),
                InstallationInput::Portable(value) => (
                    O::InputCodec::decode(value)
                        .map_err(|_| InstallationCallFault::InvalidInput)?,
                    true,
                ),
            };
            let result = self
                .executor
                .call(context, input, move |output| {
                    !portable
                        || O::OutputCodec::encode(output)
                            .and_then(O::OutputCodec::normalize)
                            .is_ok()
                })
                .await;
            match result {
                Ok(output) if portable => O::OutputCodec::encode(&output)
                    .and_then(O::OutputCodec::normalize)
                    .map(InstallationOutcome::PortableReturned)
                    .map_err(|_| InstallationCallFault::InvalidOutcome),
                Ok(output) => Ok(InstallationOutcome::Returned(Box::new(output))),
                Err(ReadFailure::Declared(error)) if portable => {
                    let code = error.code().to_owned();
                    O::ErrorCodec::encode(&error)
                        .and_then(|details| {
                            crate::codec::normalize_declared::<O::Error, O::ErrorCodec>(
                                &code, details,
                            )
                        })
                        .map(|details| InstallationOutcome::PortableDeclared { code, details })
                        .map_err(|_| InstallationCallFault::InvalidOutcome)
                }
                Err(ReadFailure::Declared(error)) => {
                    Ok(InstallationOutcome::Declared(Box::new(error)))
                }
                Err(ReadFailure::Adapter(ObservationFault::Denied(code))) => {
                    Ok(InstallationOutcome::Denied(code))
                }
                Err(ReadFailure::Adapter(ObservationFault::Unavailable)) => {
                    Err(InstallationCallFault::Unknown)
                }
                Err(ReadFailure::InvalidOutput) => Err(InstallationCallFault::InvalidOutcome),
            }
        })
    }
}

/// Contributes a native observed-read realization with an installation-local cache.
///
/// Only `ReadOnly` interactions can use this constructor. The contribution is
/// consumed by one installation; its exact compiled contract, realization, and
/// installation allocation cannot change or share retained results. Revocation
/// clears retained values and closes the executor.
///
/// Native input/scope equality must represent exact immutable request and
/// visibility identity. Native `Clone` implementations must create independent
/// retained values; sharing interior-mutable application state violates the host
/// snapshot contract. Exact typed calls do not cross a wire codec.
///
/// State-changing declarations cannot be contributed through this capability:
///
/// ```compile_fail
/// use boundary_core::{ChangesState, Interaction};
/// use boundary_core::lifecycle::{CompiledInteraction, RealizationId, observed_read_realization};
/// use boundary_core::observations::{ObservedReadOptions, ReadEvaluator, SnapshotSource};
///
/// fn changing_read<O, S, E>(interaction: &CompiledInteraction<O>, id: RealizationId, source: S, evaluator: E)
/// where
///     O: Interaction<Effect = ChangesState> + Clone + Eq + Sync,
///     O::Output: Clone,
///     S: SnapshotSource,
///     E: ReadEvaluator<O, (), S::Snapshot>,
/// {
///     observed_read_realization(interaction, id, source, evaluator, ObservedReadOptions::default());
/// }
/// ```
#[must_use]
pub fn observed_read_realization<O, C, Source, Eval>(
    interaction: &CompiledInteraction<O>,
    realization_id: RealizationId,
    source: Source,
    evaluator: Eval,
    options: ObservedReadOptions,
) -> InstallationContribution<C>
where
    O: Interaction<Effect = ReadOnly> + Clone + Eq + Sync,
    O::Output: Clone,
    C: Sync + ?Sized + 'static,
    Source: SnapshotSource<C>,
    Eval: ReadEvaluator<O, C, Source::Snapshot>,
{
    InstallationContribution {
        interaction: interaction.erase(),
        realization_id: Some(realization_id),
        kind: ContributionKind::Direct(Arc::new(ObservedDirect {
            executor: ObservedExecutor::new(source, evaluator, options),
            _context: PhantomData,
        })),
    }
}
