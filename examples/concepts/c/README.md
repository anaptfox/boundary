# Native C and C++ consumers

These two files are the consumers that `just native-abi-smoke` builds against
the staged public header and the `boundary-ffi` library. They prove that the
hand-written [`boundary.h`](../../../crates/boundary-ffi/include/boundary.h)
compiles and links from C11 and C++17, and that the ABI behaves as documented.

- [`native-host.c`](native-host.c) is a host with one selected Binding. It checks:
  - the ABI version and capability bits;
  - that interactions left out of the selection are hidden from the manifest and
    cannot be invoked;
  - admission denial and allowance, direct and request modes;
  - a declared error, and malformed or wrongly typed input, plus a stale invocation
    whose realization ID was altered, all rejected before any admission or dispatch;
  - an outcome reported as `unknown` after a host effect whose response was lost,
    with the effect counted once and never retried;
  - revocation, and a second Binding that still completes;
  - zero-argument interactions.
- [`header-cxx.cpp`](header-cxx.cpp) is a C++17 consumer. It only compiles the
  header and checks `boundary_abi_version()`, so it proves the header is usable
  from C++ and nothing more.

## Run

```sh
just native-abi-smoke
```

The recipe builds the libraries with `just native-abi-build`, then:

1. stages the header and libraries in an isolated prefix;
2. checks that the header declares exactly the exported `boundary_*` symbols;
3. builds a dynamic C host, a dynamic C++ host, and a static C host;
4. moves the prefix and runs all three, so the loader paths must still resolve;
5. builds and runs a C host instrumented with AddressSanitizer and UBSan.

The Rust library itself is not sanitizer-instrumented.

The proof needs `cc`, `c++`, and `nm`, plus `otool` on macOS or `readelf` on Linux.
It supports macOS and Linux only. On other systems it reports `blocked`, not
passed. The [native embedding guide](../../../docs/guides/native-embedding.md)
shows the manual build and link commands.
