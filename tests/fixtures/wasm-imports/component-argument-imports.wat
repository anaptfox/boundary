(component
  (type $small (instance
    (type (func))
    (export "allowed" (func (type 0)))))
  (type $wide (instance
    (type (func))
    (export "allowed" (func (type 0)))
    (export "extra" (func (type 0)))))
  (type $factory (component
    (alias outer 1 $small (type $expectedShape))
    (export "shape" (type (eq $expectedShape)))))
  (component $actual
    (alias outer 1 $wide (type $actualShape))
    (export "shape" (type $actualShape)))
  (component $forward
    (alias outer 1 $factory (type $expectedFactory))
    (import "factory" (component $maker (type $expectedFactory)))
    (export "factory" (component $maker)))
  (instance $made (instantiate $forward (with "factory" (component $actual))))
  (alias export $made "factory" (component $resolvedFactory))
  (instance $produced (instantiate $resolvedFactory))
  (alias export $produced "shape" (type $resolvedShape))
  (import "derived" (instance (type $resolvedShape))))
