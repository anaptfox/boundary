use crate::types::{Admit, Dispatch, Slice, text, view};
use boundary_core::lifecycle::{
    Admission, AdmissionDecision, AdmissionRequest, InteractionMode, NativeValueDispatcher,
    NativeValueFault, NativeValueOutcome,
};
use boundary_core::{InteractionDescriptor, parse_portable_json};
use serde_json::Value;
use std::ffi::c_void;

pub(crate) struct Context {
    pub userdata: usize,
    pub caller: usize,
    pub admit: Option<Admit>,
    pub dispatch: Option<Dispatch>,
}
pub(crate) struct Policy;
impl Admission<Context> for Policy {
    fn admit<'a>(
        &'a self,
        req: AdmissionRequest<'a, Context>,
    ) -> impl std::future::Future<Output = AdmissionDecision> + Send + 'a {
        std::future::ready(admit(&req))
    }
}
fn admit(req: &AdmissionRequest<'_, Context>) -> AdmissionDecision {
    let c = req.context();
    let Some(callback) = c.admit else {
        return AdmissionDecision::Deny {
            code: "NOT_ADMITTED".into(),
        };
    };
    let Some(input) = req.portable_input() else {
        return AdmissionDecision::Deny {
            code: "NOT_ADMITTED".into(),
        };
    };
    let input = input.to_string();
    let id = req.interaction().interaction_id().as_str();
    let mode = match req.mode() {
        InteractionMode::Direct => 1,
        InteractionMode::Request => 2,
    };
    // SAFETY: callback and userdata are host-supplied; borrowed slices remain live through the call.
    let allowed = unsafe {
        callback(
            c.userdata as *mut c_void,
            c.caller as *mut c_void,
            view(id),
            mode,
            view(&input),
        )
    };
    if allowed == 1 {
        AdmissionDecision::Admit
    } else {
        AdmissionDecision::Deny {
            code: "NOT_ADMITTED".into(),
        }
    }
}
pub(crate) struct Dispatcher(pub u32);
impl NativeValueDispatcher<Context> for Dispatcher {
    fn dispatch(
        &self,
        c: &Context,
        interaction: &InteractionDescriptor,
        input: &Value,
    ) -> Result<NativeValueOutcome, NativeValueFault> {
        let callback = c.dispatch.ok_or(NativeValueFault)?;
        let encoded = input.to_string();
        let mut reply = Slice {
            ptr: std::ptr::null(),
            len: 0,
        };
        // SAFETY: host callback follows the ABI, input slices live through this call, and reply is copied immediately.
        let status = unsafe {
            callback(
                c.userdata as *mut c_void,
                c.caller as *mut c_void,
                view(interaction.contract().id().as_str()),
                self.0,
                view(&encoded),
                &raw mut reply,
            )
        };
        if status != 0 {
            return Err(NativeValueFault);
        }
        // SAFETY: the host guarantees reply bytes remain readable until invocation returns.
        let value = parse_portable_json(unsafe { text(reply) }.map_err(|_| NativeValueFault)?)
            .map_err(|_| NativeValueFault)?;
        let obj = value.as_object().ok_or(NativeValueFault)?;
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(NativeValueFault)?;
        match (self.0, kind) {
            (1, "returned") if obj.len() == 2 => Ok(NativeValueOutcome::Returned(
                obj.get("value").ok_or(NativeValueFault)?.clone(),
            )),
            (1, "declared-error") if obj.len() == 3 => Ok(NativeValueOutcome::Declared {
                code: obj
                    .get("code")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or(NativeValueFault)?
                    .into(),
                details: obj.get("details").ok_or(NativeValueFault)?.clone(),
            }),
            (2, "proposed") if obj.len() == 2 => Ok(NativeValueOutcome::Proposed(
                obj.get("proposal").ok_or(NativeValueFault)?.clone(),
            )),
            (_, "denied") if obj.len() == 2 => Ok(NativeValueOutcome::Denied(
                obj.get("code")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or(NativeValueFault)?
                    .into(),
            )),
            _ => Err(NativeValueFault),
        }
    }
}
