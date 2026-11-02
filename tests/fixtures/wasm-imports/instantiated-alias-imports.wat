(component
  (type $small (instance
    (type (func))
    (export "allowed" (func (type 0)))))
  (type $wide (instance
    (type (func))
    (export "allowed" (func (type 0)))
    (export "extra" (func (type 0)))))
  (component $forward
    (alias outer 1 $small (type $expected))
    (import "shape" (type $t (eq $expected)))
    (export "shape" (type $t)))
  (instance $made (instantiate $forward (with "shape" (type $wide))))
  (alias export $made "shape" (type $resolved))
  (import "derived" (instance (type $resolved))))
