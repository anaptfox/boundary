(component
  (type $provider (instance
    (type $shape (instance
      (type (func))
      (export "run" (func (type 0)))))
    (export "shape" (type (eq $shape)))))
  (import "provider" (instance $provider-instance (type $provider)))
  (alias export $provider-instance "shape" (type $shape-alias))
  (import "derived" (instance (type $shape-alias))))
