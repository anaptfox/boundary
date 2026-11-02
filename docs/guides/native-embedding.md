---
title: "Embed Boundary in a native host"
description: "Build and call Boundary's versioned C ABI from a C or C++ application."
---

# Embed Boundary in a native host

A native application can publish a selected set of its own interactions through
Boundary's C ABI. The application owns its data, dispatcher, admission policy,
per-attempt context, callback memory, and lifecycle. Boundary checks the selected
contracts, identities, inputs and outcomes. A manifest describes a selection;
it does not authorize an invocation or promise that it will succeed.

Build the shared and static libraries with `just native-abi-build`. The public
header is `crates/boundary-ffi/include/boundary.h`. Compile against that header
and link the produced `boundary_ffi` library, using your platform's ordinary
native linker and loader. `just native-abi-smoke` stages a header and library
in an isolated prefix, compiles C11 and C++ consumers, moves the prefix and
runs both shared and static links. It also exercises a sanitizer-instrumented
C consumer. A C compiler, C++ compiler and supported native linker are required;
the focused proof currently supports macOS and Linux. The complete host example
is [native-host.c](../../examples/concepts/c/native-host.c).

For example, on macOS, stage and link without installing anything system-wide:

```sh
mkdir -p /tmp/boundary-native/include /tmp/boundary-native/lib /tmp/boundary-native/bin
cp crates/boundary-ffi/include/boundary.h /tmp/boundary-native/include/
cp target/debug/libboundary_ffi.dylib /tmp/boundary-native/lib/
cc -std=c11 -Wall -Wextra -Werror -I/tmp/boundary-native/include \
  examples/concepts/c/native-host.c -L/tmp/boundary-native/lib -lboundary_ffi \
  -Wl,-rpath,@loader_path/../lib -o /tmp/boundary-native/bin/host
/tmp/boundary-native/bin/host
```

On Linux, stage `libboundary_ffi.so` instead and use
`-Wl,-rpath,'$ORIGIN/../lib'`. A consuming application's packaging and signing
remain its responsibility.

## One host, one selected Binding

1. Check `boundary_abi_version()` and `boundary_capabilities()` before using the
   ABI. Set the `struct_size` of each callbacks and interaction structure to its
   actual size. Create a host with an installation ID and callbacks.
2. Add interaction declarations with their host-owned IDs, aliases, JSON schema
   slices and read/change footprints. Select direct and/or request mode explicitly;
   provide the corresponding realization IDs and, for requests, the control digest
   and preview schema. An interaction with no selected modes remains declared
   without becoming callable through that Binding. Zero-input interactions use
   the canonical empty-object schema and `{}` input; the host cannot declare a
   broader schema while calling the interaction zero-arity.
3. Bind the selection, then obtain its manifest. Use
   `boundary_binding_invocation` to make a pinned Handoff for one interaction,
   mode and JSON input. Explicitly invoke it with the context for that attempt.
4. Check the API status and then the returned Handoff outcome. A direct return,
   declared error, denial, request proposal and unknown outcome have different
   meanings. A proposal is not a direct execution; an unknown outcome is not
   permission to retry. A failed request reports `not-started` for the requested
   interaction effect; it does not prove that no ancillary proposal record was
   written. Neither outcome authorizes an automatic retry. Reconcile uncertainty
   in the host.
5. Revoke when access ends. Destroy every Binding before destroying its host,
   and free each returned `boundary_buffer` exactly once with
   `boundary_buffer_free`.

The callback receives host userdata and the per-invocation context. Admission is
checked for every attempt; a missing admission callback denies. Dispatch returns
one of the reply shapes documented in the header. The `interaction_id` and
`input_json` slices passed into each callback are valid only for that callback;
copy them if the host needs to retain them. The host must keep its dispatch
reply memory valid until `boundary_binding_invoke` returns. Returned buffers
belong to Boundary: do not free them with the host's allocator. Do not hand
Boundary a pointer that does not cover the stated length.
Each input slice, including a callback reply, is limited to 16 MiB
(16,777,216 bytes).

ABI v1 calls and callbacks are synchronous. Handles are thread-confined and
non-reentrant; do not call Boundary, revoke, or destroy a handle from within a
callback, or use it after destruction. The library does not create a host policy,
run a language runtime subprocess, or automatically retry effects. The header is
the authoritative contract for status codes, supported callback replies and
pointer/lifetime requirements. Unreadable pointers, foreign exceptions or
longjmp across a callback are outside that contract.
