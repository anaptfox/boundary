;; Wrong signature (extra parameter) behind the same exported-type alias shape.
;; Refused before startup; the core start function would enter the host.
(component
  (type $reply0 (result string (error string)))
  (instance $types (export "reply" (type $reply0)))
  (alias export $types "reply" (type $reply))
  (type $host (instance
    (alias outer 1 $reply (type $r))
    (type $f (func (param "request" string) (param "extra" u32) (result $r)))
    (export "images" (func (type $f)))))
  (import "boundary:guest/footprints@1.0.0" (instance $host (type $host)))
  (alias export $host "images" (func $images))
  (core module $libc
    (memory (export "memory") 1)
    (data (i32.const 0) "abcdefghijklmnop")
    (func (export "realloc") (param i32 i32 i32 i32) (result i32) i32.const 2048))
  (core instance $libc (instantiate $libc))
  (core func $images (canon lower (func $images)
    (memory (core memory $libc "memory")) (realloc (core func $libc "realloc"))))
  (core module $guest
    (import "" "images" (func (param i32 i32 i32 i32)))
    (func $start i32.const 0 i32.const 16 i32.const 7 i32.const 512 call 0  unreachable)
    (start $start))
  (core instance $guest (instantiate $guest
    (with "" (instance (export "images" (func $images)))))))
