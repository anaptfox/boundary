(component
  (type $host (instance
    (type $reply (result string (error string)))
    (export "images" (func (param "request" string)))))
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
    (import "" "images" (func (param i32 i32)))
    (func $start i32.const 0 i32.const 16 call 0  unreachable)
    (start $start))
  (core instance $guest (instantiate $guest
    (with "" (instance (export "images" (func $images)))))))
