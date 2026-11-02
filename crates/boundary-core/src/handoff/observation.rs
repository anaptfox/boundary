use super::{CheckedHandoff, HandoffError, HandoffInvocation, HandoffOutcome};
use crate::{
    canonical_json,
    lifecycle::{Admission, InvocationObservation},
};
use serde_json::{Value, json};
use std::future::Future;

impl<Context, A> CheckedHandoff<'_, Context, A>
where
    Context: Sync + ?Sized + 'static,
    A: Admission<Context>,
{
    /// Invokes once and awaits optional host-owned publication of validated evidence.
    /// Publication errors cannot alter execution truth. Inputs, outputs and context
    /// are never published; the host explicitly chooses redacted correlation data.
    ///
    /// # Errors
    /// Returns the same pre-dispatch identity errors as [`Self::invoke`].
    pub async fn invoke_observed<Publish, Published, DeliveryError>(
        &self,
        invocation: HandoffInvocation,
        context: &Context,
        correlation: Option<Value>,
        publish: Publish,
    ) -> Result<HandoffOutcome, HandoffError>
    where
        Publish: FnOnce(InvocationObservation) -> Published,
        Published: Future<Output = Result<(), DeliveryError>>,
    {
        let interaction_id = invocation.interaction_id().clone();
        let correlation = correlation.filter(|value| canonical_json(value).is_ok());
        let outcome = self.invoke(invocation, context).await?;
        if let Some(descriptor) = self
            .manifest()
            .actual_program()
            .interaction(&interaction_id)
            && let Ok(Value::Object(mut event)) = serde_json::to_value(&outcome)
        {
            if let Some(result) = event.remove("result") {
                event.insert("resultKind".to_owned(), result["kind"].clone());
            }
            event.insert(
                "projectionDigest".to_owned(),
                json!(self.manifest().projection_digest()),
            );
            event.insert(
                "installationDigest".to_owned(),
                json!(self.manifest().installation_digest()),
            );
            event.insert("reads".to_owned(), json!(descriptor.contract().reads()));
            event.insert("changes".to_owned(), json!(descriptor.contract().changes()));
            if let Some(correlation) = correlation {
                event.insert("correlation".to_owned(), correlation);
            }
            if let Ok(observation) = InvocationObservation::from_value(Value::Object(event)) {
                let _ = publish(observation).await;
            }
        }
        Ok(outcome)
    }
}
