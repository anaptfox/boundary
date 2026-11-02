;; A real Wasm loop. It must be interrupted by terminating the worker; Node's
;; event loop cannot preempt a synchronous WebAssembly export in-process.
(module
  (type (func (param i32 i32) (result i32)))
  (type (func (param i32)))
  (type (func (param i32 i32 i32 i32) (result i32)))
  (type (func))
  (memory 1)
  (export "cm32p2||run" (func $run))
  (export "cm32p2||run_post" (func $post))
  (export "cm32p2_memory" (memory 0))
  (export "cm32p2_realloc" (func $realloc))
  (export "cm32p2_initialize" (func $initialize))
  (func $run (type 0) (param i32 i32) (result i32)
    (loop $forever br $forever)
    unreachable)
  (func $post (type 1) (param i32))
  (func $realloc (type 2) (param i32 i32 i32 i32) (result i32) (i32.const 128))
  (func $initialize (type 3)))
