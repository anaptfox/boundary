(module
          (tag $e)
          (func $run (export "run") (param $cnt i32) (param $depth i32)
            (local $i i32)
            (local.set $i (local.get $cnt))
            local.get $depth
            if
              (local.set $depth (i32.sub (local.get $depth) (i32.const 1)))
              loop $l
                (block $catch
                  (try_table (catch $e $catch)
                    (call $run (local.get $cnt) (local.get $depth))))
                (local.tee $i (i32.sub (local.get $i) (i32.const 1)))
                if br $l end
              end
            end
          )
        )
