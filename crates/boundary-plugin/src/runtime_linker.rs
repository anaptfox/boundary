//! Immutable import linking, reusable across fresh guest stores.
use super::{GuestState, HostFunctions, HostReply, PluginComponent, PluginError};
use std::sync::Arc;
use wasmtime::Engine;
use wasmtime::component::{InstancePre, Linker};

pub(super) fn prepare(
    engine: &Engine,
    guest: &PluginComponent,
    imports: &HostFunctions,
    interface: &str,
) -> Result<InstancePre<GuestState>, PluginError> {
    guest.require_provided(&imports.declared_imports(interface))?;
    let mut linker: Linker<GuestState> = Linker::new(engine);
    // Define exactly the functions this component imports, under the exact
    // instance names it imports them from. Anything it did not ask for is
    // never defined, and anything it asked for outside the offer already
    // failed the check above.
    for import in guest.required_imports() {
        let Some(instance_name) = import.instance.as_deref() else {
            continue;
        };
        let Some(function) = imports.get(&import.name) else {
            continue;
        };
        let function = Arc::clone(function);
        let request_name = import.name.clone();
        let mut instance = linker
            .instance(instance_name)
            .map_err(|error| PluginError::Load(error.to_string()))?;
        instance
            // Typed registration pins the exact signature
            // `(string) -> result<string, string>`. Wasmtime checks it against
            // the component's declared import when `instantiate_pre` links, so
            // a mismatch is refused here, before any guest code (including a
            // core start function) can enter the host.
            .func_wrap(&import.name, move |mut store, (request,): (String,)| {
                // Copy budget: the request is counted before the host function
                // can run, the reply before the guest can see it.
                store.data_mut().charge_hostcall(request.len(), "request")?;
                let value: Result<String, String> = match function(&request) {
                    HostReply::Returned(reply) => Ok(reply),
                    HostReply::DeclaredError(failure) => Err(failure),
                    // Deliberately a trap rather than an `err` payload.
                    // Uncertainty must not be handed to the guest as a
                    // domain error it can catch and flatten.
                    HostReply::Unknown(reason) => {
                        return Err(wasmtime::Error::msg(format!(
                            "host import {request_name:?} could not confirm its effect: {reason}"
                        )));
                    }
                };
                let (Ok(payload) | Err(payload)) = &value;
                store.data_mut().charge_hostcall(payload.len(), "reply")?;
                Ok((value,))
            })
            .map_err(|error| PluginError::Load(error.to_string()))?;
    }

    // The signature check runs here. No store exists yet and nothing has run.
    linker
        .instantiate_pre(guest.component())
        .map_err(|error| PluginError::Load(format!("{error:#}")))
}
