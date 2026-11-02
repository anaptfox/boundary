# boundary-cli

The `boundary` command: a per-user local bus and interaction discovery.

- **Tier:** binary · **Minimum Rust:** 1.96 · **Publishing:** not published (`publish = false`)
- **TypeScript counterpart:** none as a command. `@foxworth/boundary/bus` and `@foxworth/boundary/mcp` are the library counterparts.

The binary composes `boundary-bus`, `boundary-mcp`, and `boundary-reach`. It owns no behavior of its own.

```sh
just boundary-build        # builds target/debug/boundary
./target/debug/boundary --help
```

```text
boundary bus [--socket PATH]                      Run the per-user bus
boundary list [--socket PATH]                     List reachable interactions
boundary call <interactionId> [--input JSON] [--mode direct|request]
    [--binding DIGEST] [--socket PATH]            Invoke one interaction
boundary mcp [--socket PATH]                      Serve reachable interactions to a model
```

- `call` exits non-zero unless the result is `returned` or `proposed`. It never retries.
- Without `--mode`, a binding that exposes both modes is called in request mode.
- The socket is `$BOUNDARY_BUS_SOCKET`, or `~/.boundary/bus.sock` if that is unset.

Tests: `crates/boundary-cli/tests/call_cli.rs` and `tests/cli_discovery.rs`, run with `cargo test -p boundary-cli`.
