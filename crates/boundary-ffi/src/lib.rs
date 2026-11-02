//! Synchronous, host-owned C ABI over Boundary's checked native lifecycle.
mod adapter;
mod types;
use adapter::{Context, Dispatcher, Policy};
use boundary_core::handoff::{HandoffInvocation, checked_handoff};
use boundary_core::lifecycle::{
    BindResult, Binding, BindingController, InstallationId, InteractionMode, bind, install,
    native_declared_interaction, native_direct_realization, native_request_realization, project,
    select_native,
};
use boundary_core::{InteractionId, parse_portable_json};
use std::{
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
};
use types::{Buffer, Callbacks, Definition, Interaction, Slice, definition, encode, text};

/// Opaque host handle; ownership is defined by the C header.
pub struct Host {
    id: InstallationId,
    callbacks: Callbacks,
    defs: Vec<Definition>,
}
/// Opaque Binding handle; ownership is defined by the C header.
pub struct Bound {
    binding: Binding<Context, Policy>,
    controller: BindingController,
    userdata: usize,
    admit: Option<types::Admit>,
    dispatch: Option<types::Dispatch>,
}
fn guard(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => 4,
    }
}
fn mode(n: u32) -> Result<InteractionMode, i32> {
    match n {
        1 => Ok(InteractionMode::Direct),
        2 => Ok(InteractionMode::Request),
        _ => Err(1),
    }
}
/// Returns the ABI version.
#[unsafe(no_mangle)]
pub extern "C" fn boundary_abi_version() -> u32 {
    1
}
/// Returns supported capability bits.
#[unsafe(no_mangle)]
pub extern "C" fn boundary_capabilities() -> u64 {
    3
}
/// Creates a host handle.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_host_create(
    version: u32,
    id: Slice,
    callbacks: *const Callbacks,
    out: *mut *mut Host,
) -> i32 {
    guard(|| {
        if out.is_null() || callbacks.is_null() || version != 1 {
            return Err(1);
        } // SAFETY: output is a writable host-provided pointer.
        unsafe { *out = std::ptr::null_mut() };
        // SAFETY: slice points to readable memory per header contract.
        // SAFETY: caller guarantees at least the size field is readable and aligned.
        if unsafe { (*callbacks).struct_size } < std::mem::size_of::<Callbacks>() {
            return Err(1);
        }
        // SAFETY: validated size covers the current callback structure.
        let callbacks = unsafe { *callbacks };
        let id = InstallationId::new(unsafe { text(id) }?).map_err(|_| 2)?;
        // SAFETY: output was checked and remains writable.
        unsafe {
            *out = Box::into_raw(Box::new(Host {
                id,
                callbacks,
                defs: Vec::new(),
            }));
        };
        Ok(())
    })
}
/// Adds one host declaration.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_host_add(host: *mut Host, raw: *const Interaction) -> i32 {
    guard(|| {
        if host.is_null() || raw.is_null() {
            return Err(1);
        }
        // SAFETY: live unique handle and readable struct are guaranteed by caller.
        // SAFETY: caller guarantees the size field is readable and aligned.
        if unsafe { (*raw).struct_size } < std::mem::size_of::<Interaction>() {
            return Err(1);
        }
        // SAFETY: validated size covers the current interaction structure.
        let item = unsafe { definition(&*raw) }?;
        unsafe { &mut *host }.defs.push(item);
        Ok(())
    })
}
/// Creates an exact live Binding.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_host_bind(host: *mut Host, out: *mut *mut Bound) -> i32 {
    guard(|| {
        if host.is_null() || out.is_null() {
            return Err(1);
        } // SAFETY: live handle and writable output supplied by host.
        let host = unsafe { &mut *host };
        unsafe { *out = std::ptr::null_mut() };
        let mut selections = Vec::new();
        let mut contributions = Vec::new();
        for d in &host.defs {
            if let Some(m) = d.modes {
                selections.push(select_native(&d.alias, &d.native, m).map_err(|_| 2)?);
            }
            if let Some(id) = &d.direct {
                contributions.push(native_direct_realization(
                    &d.native,
                    id.clone(),
                    Arc::new(Dispatcher(1)),
                ));
            }
            if let Some((id, identity)) = &d.request {
                contributions.push(native_request_realization(
                    &d.native,
                    id.clone(),
                    identity.clone(),
                    Arc::new(Dispatcher(2)),
                ));
            }
            if d.modes.is_none() {
                contributions.push(native_declared_interaction(&d.native));
            }
        }
        let projection = project(selections).map_err(|_| 2)?;
        let installed = install(host.id.clone(), contributions).map_err(|_| 2)?;
        let BindResult::Bound(bound) = bind(&projection, &installed.installation, Policy) else {
            return Err(3);
        };
        let b = Bound {
            binding: bound.binding,
            controller: bound.controller,
            userdata: host.callbacks.userdata as usize,
            admit: host.callbacks.admit,
            dispatch: host.callbacks.dispatch,
        };
        // SAFETY: output pointer is writable and caller owns resulting handle.
        unsafe { *out = Box::into_raw(Box::new(b)) };
        Ok(())
    })
}
fn output(out: *mut Buffer, value: &impl ToString) -> Result<(), i32> {
    if out.is_null() {
        return Err(1);
    } // SAFETY: host provides writable output storage.
    unsafe { *out = encode(value) };
    Ok(())
}
/// Copies the Binding manifest to a library-owned buffer.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_binding_manifest(binding: *mut Bound, out: *mut Buffer) -> i32 {
    guard(|| {
        if binding.is_null() || out.is_null() {
            return Err(1);
        } // SAFETY: live handle required by ABI.
        let binding = unsafe { &*binding };
        let json = serde_json::to_value(binding.binding.manifest()).map_err(|_| 4)?;
        output(out, &json)
    })
}
/// Constructs one pinned invocation.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_binding_invocation(
    binding: *mut Bound,
    id: Slice,
    mode_value: u32,
    input: Slice,
    out: *mut Buffer,
) -> i32 {
    guard(|| {
        if binding.is_null() || out.is_null() {
            return Err(1);
        } // SAFETY: valid handle and readable slices required by ABI.
        let binding = unsafe { &*binding };
        let id = InteractionId::parse(unsafe { text(id) }?).map_err(|_| 2)?;
        let input = parse_portable_json(unsafe { text(input) }?).map_err(|_| 2)?;
        let invocation =
            HandoffInvocation::new(binding.binding.manifest(), &id, mode(mode_value)?, input)
                .map_err(|_| 2)?;
        output(out, &serde_json::to_value(invocation).map_err(|_| 4)?)
    })
}
/// Executes one checked invocation.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_binding_invoke(
    binding: *mut Bound,
    invocation: Slice,
    context: *mut c_void,
    out: *mut Buffer,
) -> i32 {
    guard(|| {
        if binding.is_null() || out.is_null() {
            return Err(1);
        } // SAFETY: valid handle and input slice required by ABI.
        let b = unsafe { &*binding };
        // SAFETY: caller supplies a readable invocation slice for this call.
        let source = unsafe { text(invocation) }?;
        // Check strict portable JSON first; deserialize the original bytes so
        // integer protocol fields retain their integer representation.
        parse_portable_json(source).map_err(|_| 2)?;
        let invocation: HandoffInvocation = serde_json::from_str(source).map_err(|_| 2)?;
        let ctx = Context {
            userdata: b.userdata,
            caller: context as usize,
            admit: b.admit,
            dispatch: b.dispatch,
        };
        let result =
            futures::executor::block_on(checked_handoff(&b.binding).invoke(invocation, &ctx))
                .map_err(|_| 2)?;
        output(out, &serde_json::to_value(result).map_err(|_| 4)?)
    })
}
/// Revokes one Binding.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_binding_revoke(binding: *mut Bound) -> i32 {
    guard(|| {
        if binding.is_null() {
            return Err(1);
        } // SAFETY: caller supplies a live handle.
        let b = unsafe { &*binding };
        let _ = b.controller.revoke();
        Ok(())
    })
}
/// Destroys one Binding handle.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_binding_destroy(binding: *mut Bound) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !binding.is_null() {
            // SAFETY: caller owns this live handle and destroys it exactly once.
            unsafe { drop(Box::from_raw(binding)) };
        }
    }));
}
/// Destroys one host handle.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_host_destroy(host: *mut Host) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !host.is_null() {
            // SAFETY: caller owns this live handle and destroys it exactly once.
            unsafe { drop(Box::from_raw(host)) };
        }
    }));
}
/// Releases a library-owned buffer.
///
/// # Safety
/// Callers must obey the pointer, lifetime, ownership and non-reentrancy requirements in `boundary.h`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boundary_buffer_free(buffer: Buffer) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !buffer.ptr.is_null() {
            // SAFETY: only exact buffers returned by this library may be freed once.
            unsafe {
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    buffer.ptr, buffer.len,
                )));
            };
        }
    }));
}
