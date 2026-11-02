#!/usr/bin/env bash
# Guest matrix: build one language's component and run its ignored e2e tests.
# A missing toolchain prints `blocked` and exits 0. A row that did not run is
# never a pass. Status lines land in target/guest-matrix-status for the summary.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
status_file="$root/target/guest-matrix-status"
mkdir -p "$root/target"

pin() {
  node -e "const p=JSON.parse(require('fs').readFileSync('config/wasm-versions.json','utf8')); console.log($1)"
}

block() {
  local row="$1"
  local reason="$2"
  echo "blocked: $reason"
  echo "blocked $row" >> "$status_file"
  exit 0
}

pass() {
  local row="$1"
  local message="$2"
  echo "✓ $message"
  echo "pass $row" >> "$status_file"
}

# Build inputs and output bytes must both match. Validation/tests run on hits too.
cache_key() { node ./scripts/wasm/build-cache.ts key "$1" "$2"; }
cache_hit() {
  [[ "${BOUNDARY_GUEST_REBUILD:-0}" != 1 ]] && node ./scripts/wasm/build-cache.ts hit "$1" "$2"
}
cache_record() { node ./scripts/wasm/build-cache.ts record "$1" "$2" "$3"; }

run_zig() {
  command -v zig >/dev/null || block zig "the Zig guest requires zig on PATH"
  command -v wasm-tools >/dev/null || block zig "the Zig guest requires wasm-tools on PATH"
  ( cd examples/guests/thumbnail/zig && zig build )
  wasm-tools validate --features component-model examples/guests/thumbnail/zig/zig-out/thumbnail.component.wasm
  cargo test -p boundary-plugin --test zig_guest_end_to_end -- --ignored
  pass zig "zig guest component built and executed"
}

run_rust() {
  command -v cargo-component >/dev/null || block rust "the Rust guest requires cargo-component on PATH"
  command -v wasm-tools >/dev/null || block rust "the Rust guest requires wasm-tools on PATH"
  ( cd examples/guests/thumbnail/rust && cargo component build --release --target wasm32-unknown-unknown )
  wasm-tools validate --features component-model \
    examples/guests/thumbnail/rust/target/wasm32-unknown-unknown/release/boundary_thumbnail_guest.wasm
  cargo test -p boundary-plugin --test rust_guest_end_to_end --test plugin_binding -- --ignored
  pass rust "rust guest component built and executed"
}

run_js() {
  command -v wasm-tools >/dev/null || block js "the JavaScript guest requires wasm-tools on PATH"
  local jco_ver
  jco_ver="$(pin 'p.cli.jco')"
  local -a jco
  if [[ -x "$root/packages/node_modules/.bin/jco" ]]; then
    jco=("$root/packages/node_modules/.bin/jco")
  else
    block js "the JavaScript guest requires workspace jco ${jco_ver}; run pnpm install"
  fi
  local tool_identity key
  if ! tool_identity="$("${jco[@]}" --version)"; then
    block js "the JavaScript guest requires jco ${jco_ver}"
  fi
  [[ "$tool_identity" == "$jco_ver" ]] || block js "expected jco ${jco_ver}, found ${tool_identity}"
  tool_identity="${jco[*]}|${tool_identity}|$(wasm-tools --version)"
  key="$(cache_key js "$tool_identity")"
  if cache_hit js "$key"; then
    echo "cached: JavaScript component inputs and artifact match"
  else
    (
      cd examples/guests/thumbnail/javascript
      "${jco[@]}" componentize thumbnail.js --wit wit --world-name guest \
        --out thumbnail.component.wasm --disable all
    )
  fi
  wasm-tools validate --features component-model examples/guests/thumbnail/javascript/thumbnail.component.wasm
  cache_record js "$key" "$tool_identity"
  cargo test -p boundary-plugin --test js_guest_end_to_end -- --ignored --test-threads=1
  pass js "javascript guest component built and executed"
}

run_python() {
  command -v componentize-py >/dev/null || block python "the Python guest requires componentize-py on PATH"
  command -v wasm-tools >/dev/null || block python "the Python guest requires wasm-tools on PATH"
  local tool_identity key
  tool_identity="$(command -v componentize-py)|$(componentize-py --version)|$(wasm-tools --version)"
  key="$(cache_key python "$tool_identity")"
  if cache_hit python "$key"; then
    echo "cached: Python component inputs and artifact match"
  else
    (
      cd examples/guests/thumbnail/python
      rm -rf wit_world componentize_py_async_support
      rm -f poll_loop.py componentize_py_types.py componentize_py_runtime.pyi
      componentize-py -d wit -w guest bindings .
      componentize-py -d wit -w guest componentize app --stub-wasi -o thumbnail.component.wasm
    )
  fi
  wasm-tools validate --features component-model examples/guests/thumbnail/python/thumbnail.component.wasm
  cache_record python "$key" "$tool_identity"
  cargo test -p boundary-plugin --test python_guest_end_to_end -- --ignored --test-threads=1
  pass python "python guest component built and executed"
}

run_go() {
  command -v tinygo >/dev/null || block go "the Go guest requires tinygo on PATH"
  command -v wasm-tools >/dev/null || block go "the Go guest requires wasm-tools on PATH"
  [[ "$(tinygo version)" == *"tinygo version $(pin 'p.go.tinygo') "* ]] || block go "TinyGo does not match config/wasm-versions.json"
  local go_toolchain
  go_toolchain="$(pin 'p.go.toolchain')"
  [[ "$(GOTOOLCHAIN="$go_toolchain" go version)" == *"${go_toolchain} "* ]] || block go "Go does not match the pinned guest toolchain"
  local tool_identity key
  tool_identity="$(command -v tinygo)|$(tinygo version)|$(wasm-tools --version)|${go_toolchain}"
  key="$(cache_key go "$tool_identity")"
  if cache_hit go "$key"; then
    echo "cached: Go component inputs and artifact match"
  else
    (
      cd examples/guests/thumbnail/go
      GOTOOLCHAIN="$go_toolchain" tinygo build \
        -target=wasm-unknown -scheduler=none -gc=leaking -o thumbnail.core.wasm .
      wasm-tools component embed wit --world guest thumbnail.core.wasm -o thumbnail.embed.wasm
      wasm-tools component new thumbnail.embed.wasm -o thumbnail.component.wasm
    )
  fi
  wasm-tools validate --features component-model examples/guests/thumbnail/go/thumbnail.component.wasm
  cache_record go "$key" "$tool_identity"
  cargo test -p boundary-plugin --test go_guest_end_to_end -- --ignored
  pass go "go guest component built and executed"
}

run_summary() {
  local expected=(zig rust js python go)
  local unresolved=()
  if [[ ! -f "$status_file" ]]; then
    echo "guest matrix: no status file; a row that did not run is not a pass."
    exit 1
  fi

  local row
  if [[ "$(wc -l < "$status_file" | tr -d ' ')" != "${#expected[@]}" ]]; then
    unresolved+=("status-file")
  fi
  for row in "${expected[@]}"; do
    local pass_count
    local blocked_count
    pass_count="$(grep -c "^pass ${row}$" "$status_file" || true)"
    blocked_count="$(grep -c "^blocked ${row}$" "$status_file" || true)"
    if [[ "$pass_count" != 1 || "$blocked_count" != 0 ]]; then
      unresolved+=("$row")
    fi
  done

  echo
  if ((${#unresolved[@]} > 0)); then
    echo "guest matrix: ${#unresolved[@]} problem(s); rows are blocked, missing, or invalid:"
    for row in "${unresolved[@]}"; do
      echo "  not passed: $row"
    done
    echo "  an incomplete row proves nothing about that guest."
    exit 1
  fi
  echo "guest matrix: every row ran"
}

reset_status() {
  : > "$status_file"
}

case "${1:-}" in
  reset) reset_status ;;
  zig) run_zig ;;
  rust) run_rust ;;
  js) run_js ;;
  python) run_python ;;
  go) run_go ;;
  summary) run_summary ;;
  *)
    echo "usage: $0 reset|zig|rust|js|python|go|summary" >&2
    exit 2
    ;;
esac
