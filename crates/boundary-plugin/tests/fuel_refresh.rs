//! Qualification of the pinned runtime's fuel budget and disabled proposals.
#![allow(clippy::expect_used)]
use boundary_plugin::guest_engine;
use wasmtime::{Instance, Module, Store, Trap, Val};

#[test]
fn recursive_calls_exhaust_the_host_budget() {
    let engine = guest_engine().expect("fuel engine");
    let module = Module::new(
        &engine,
        include_bytes!("../../../tests/fixtures/wasm-fuel/recursive.wasm"),
    )
    .expect("core module");
    let mut store = Store::new(&engine, ());
    store.set_fuel(100_000).expect("budget");
    let instance = Instance::new(&mut store, &module, &[]).expect("instance");
    let run = instance.get_func(&mut store, "run").expect("export");
    let error = run
        .call(&mut store, &[Val::I32(10), Val::I32(10)], &mut [])
        .expect_err("finite budget must trap");
    assert_eq!(error.downcast_ref::<Trap>(), Some(&Trap::OutOfFuel));
}

#[test]
fn regression_shapes_are_rejected_or_exhaust_the_host_budget() {
    let engine = guest_engine().expect("engine");
    for bytes in [
        include_bytes!("../../../tests/fixtures/wasm-fuel/call-ref.wasm").as_slice(),
        include_bytes!("../../../tests/fixtures/wasm-fuel/try-table.wasm").as_slice(),
    ] {
        match Module::new(&engine, bytes) {
            Ok(module) => {
                let mut store = Store::new(&engine, ());
                store.set_fuel(100_000).expect("budget");
                let instance = Instance::new(&mut store, &module, &[]).expect("instance");
                let run = instance.get_func(&mut store, "run").expect("export");
                let error = run
                    .call(&mut store, &[Val::I32(10), Val::I32(10)], &mut [])
                    .expect_err("finite fuel must trap");
                assert_eq!(error.downcast_ref::<Trap>(), Some(&Trap::OutOfFuel));
            }
            Err(error) => {
                let reason = format!("{error:#}");
                assert!(
                    reason.contains("not enabled") || reason.contains("not supported"),
                    "unexpected rejection: {reason}"
                );
            }
        }
    }
}
