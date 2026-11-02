//! Builds the zero-WASI `images-make-thumbnail` guest component.
//!
//! Pipeline: compile `src/main.zig` (+ `src/thumbnail.zig`) to a
//! `wasm32-freestanding` core module, then hand it to `wasm-tools` twice —
//! `component embed` stamps the WIT world's component-type metadata onto the
//! core module, and `component new` wraps that into an actual Preview 2
//! component. Neither step involves a WASI adapter: this guest imports
//! nothing but `boundary:guest/footprints@1.0.0`.
//!
//! `zig build` produces `zig-out/thumbnail.component.wasm`.
//! `zig build test` runs the pure arithmetic/JSON tests in `thumbnail.zig`
//! natively — no wasm runtime required, since that file has no wasm-specific
//! code in it at all.
const std = @import("std");

pub fn build(b: *std.Build) void {
    // Defaults to small: a guest component ships as a binary, not a
    // debug session, and Debug mode drags in ubsan/debug-info bloat that
    // turns a ~60KB component into a ~950KB one. `standardOptimizeOption`'s
    // own `preferred_optimize_mode` still defaults to Debug unless the
    // caller also passes `--release`, which defeats the point here, so this
    // reads the same `-Doptimize=` flag by hand instead.
    const optimize = b.option(
        std.lang.Optimize,
        "optimize",
        "Prioritize performance, safety, or binary size (default: small)",
    ) orelse .small;

    // The pure domain logic is portable Zig; test it on the host, not wasm.
    const domain_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/thumbnail.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const test_step = b.step("test", "Run the pure thumbnail-arithmetic tests natively");
    test_step.dependOn(&b.addRunArtifact(domain_tests).step);

    // The guest core module: freestanding wasm32, no WASI, no libc, no
    // entry point (this is a reactor-style component, not a command), and
    // `rdynamic` so the Canonical ABI exports below survive the linker.
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });
    const core_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    const core = b.addExecutable(.{
        .name = "core",
        .root_module = core_module,
    });
    core.entry = .disabled;
    core.rdynamic = true;

    // `wasm-tools component embed wit/ --world guest core.wasm -o embedded.wasm`
    const embed = b.addSystemCommand(&.{ "wasm-tools", "component", "embed" });
    embed.addDirectoryArg(b.path("wit"));
    embed.addArgs(&.{ "--world", "guest" });
    embed.addFileArg(core.getEmittedBin());
    const embedded = embed.addPrefixedOutputFileArg("--output=", "embedded.wasm");

    // `wasm-tools component new embedded.wasm -o thumbnail.component.wasm`
    // No `--adapt` flag: there is no WASI import to satisfy.
    const componentize = b.addSystemCommand(&.{ "wasm-tools", "component", "new" });
    componentize.addFileArg(embedded);
    const component = componentize.addPrefixedOutputFileArg("--output=", "thumbnail.component.wasm");

    const install_component = b.addInstallFile(component, "thumbnail.component.wasm");
    b.getInstallStep().dependOn(&install_component.step);

    // `zig build validate` re-runs `wasm-tools validate` as a build step,
    // for convenience; CI and the verification below invoke it directly too.
    const validate = b.addSystemCommand(&.{ "wasm-tools", "validate", "--features", "component-model" });
    validate.addFileArg(component);
    const validate_step = b.step("validate", "Validate the component with wasm-tools");
    validate_step.dependOn(&validate.step);
}
