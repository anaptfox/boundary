# Fuel refresh fixtures

`call-ref.wat` and `try-table.wat` reproduce the recursive call shapes in
Wasmtime **v49.0.2**, `tests/all/fuel.rs:1030-1103`. Setup gives 100,000 fuel,
invokes `run(10, 10)` and requires an out-of-fuel trap. The upstream suite
explicitly enables function references / exceptions; our consumer uses the
actual `guest_engine()` configuration and accepts either a feature rejection
before execution or precisely `Trap::OutOfFuel` after admission.

`recursive.wat` is the equivalent ordinary-call budget proof. All binaries are
parsed from their adjacent WAT using **wasm-tools 1.261.0**. No production
feature was enabled for these tests. They establish configured-engine fuel
behavior, not reachability of every Wasmtime advisory through component guests.
