(component
  (type $small (instance
    (type (func))
    (export "allowed" (func (type 0)))))
  (type $wide (instance
    (type (func))
    (export "allowed" (func (type 0)))
    (export "extra" (func (type 0)))))
  (export $narrow "shape" (type $wide) (type (eq $small)))
  (import "derived" (instance (type $narrow))))
