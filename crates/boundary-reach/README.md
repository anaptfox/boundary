# boundary-reach

Reach records, plus the specified HTTP framing and a client used to reach a Binding.

- **Tier:** composition · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterparts:** `@foxworth/boundary/reach` (records) and `@foxworth/boundary/http/protocol` (framing)

A Reach record locates a Binding without granting authority. The framing module defines routes, status selection, and rejection bodies as pure decisions. It runs no server; serving stays with the host.

Feature `client` (off by default) adds blocking HTTP/TLS through `ureq` and Unix-socket calls through `socket2`. `fetch_manifest` and `invoke` exist only with this feature on Unix targets.

Conformance:

- `tests/http_framing_conformance.rs` reads `tests/conformance/v1/http-framing.json`.
- `tests/reach_conformance.rs` reads `tests/conformance/v1/reach.json`.
- `tests/http_client_conformance.rs` needs the `client` feature.

Run `just bus-test`, or `cargo test -p boundary-reach --features client`.
