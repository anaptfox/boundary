(component
  (type $shape (instance
    (type (func))
    (export "run" (func (type 0)))))
  (alias outer 0 $shape (type $aliased))
  (import "derived" (instance (type $aliased))))
