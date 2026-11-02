(component
  (type (func))
  (export "signature" (type 0))
  (type (instance
    (type (func))
    (export "first" (func (type 0)))))
  (import "boundary:guest/first@1.0.0" (instance (type 2)))
  (type (record (field "number" u32)))
  (import "record" (type (eq 3)))
  (type (instance
    (export "resource-handle" (type (sub resource)))
    (type (func))
    (export "second" (func (type 1)))))
  (import "boundary:guest/second@2.0.0" (instance (type 5)))
  (import "direct-call" (func (type 0)))
  (core module
    (import "nested" "must-not-count" (func))))
