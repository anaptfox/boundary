;; A small core module with Component Model Preview 2 ABI exports. The mutable
;; global lets the worker tests distinguish a persistent guest heap from a
;; fresh per-call instance. `run` returns one ASCII digit in an ok result and
;; traps when its input is the single character `t`.
(module
  (type (func (param i32 i32) (result i32)))
  (type (func (param i32)))
  (type (func (param i32 i32 i32 i32) (result i32)))
  (type (func))
  (memory 1)
  (global $count (mut i32) (i32.const 0))
  (export "cm32p2||run" (func $run))
  (export "cm32p2||run_post" (func $post))
  (export "cm32p2_memory" (memory 0))
  (export "cm32p2_realloc" (func $realloc))
  (export "cm32p2_initialize" (func $initialize))
  (func $run (type 0) (param $input i32) (param $length i32) (result i32)
    local.get $length
    i32.const 1
    i32.eq
    if
      local.get $input
      i32.load8_u
      i32.const 116
      i32.eq
      if unreachable end
    end
    global.get $count
    i32.const 1
    i32.add
    i32.const 10
    i32.rem_u
    global.set $count
    i32.const 64
    i32.const 0
    i32.store8
    i32.const 68
    i32.const 80
    i32.store
    i32.const 72
    i32.const 1
    i32.store
    i32.const 80
    global.get $count
    i32.const 48
    i32.add
    i32.store8
    i32.const 64)
  (func $post (type 1) (param i32))
  (func $realloc (type 2) (param i32 i32 i32 i32) (result i32) (i32.const 128))
  (func $initialize (type 3)))
