;; A valid asynchronous component function type, outside Boundary's synchronous
;; profile. It needs the component-model async feature to parse and validate.
;; Admission must refuse it before any guest code can run.
(component (type (func async)))
