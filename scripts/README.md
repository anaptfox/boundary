# Scripts

Repo composition only. These files are not tests.

- `check/` — documentation, API surface, module graph, line limit, architecture, and toolchain invariants
- `build/` — build, pack, and artifact identity
- `release/` — the reproducible release candidate and the maintainer's review and
  verify steps around npm staged publishing; see the [release runbook](./release/README.md)
- `perf/` — opt-in timings, outside the quality ladder
- `wasm/` — guest-matrix composition

Tests that need a real process live in `tests/process/`; tests for these scripts
live in `tests/scripts/` and run in `just check`.
