//! Hand-written Component Model Preview 2 Canonical ABI glue.
//!
//! There is no maintained wit-bindgen generator for Zig, so every byte of
//! ABI plumbing below — allocation, string lowering/lifting, the indirect
//! `result<string, string>` return, post-return cleanup — is written by hand
//! against the single WIT world in `wit/guest.wit`. See ../README.md for the
//! full rationale and for what breaks when Component Model 1.0 lands.
//!
//! All domain logic (the actual thumbnail arithmetic and JSON shapes) lives
//! in `thumbnail.zig`, which knows nothing about WebAssembly. This file only
//! moves bytes across the guest/host boundary and hands them to that module.
const std = @import("std");
const domain = @import("thumbnail.zig");

const allocator = std.heap.wasm_allocator;

// ============================================================================
// cabi_realloc — the one allocation entry point the Canonical ABI uses to
// cross the guest/host boundary.
// ============================================================================
//
// Two call sites use this, both driven by glue `wasm-tools component new`
// synthesizes from the component-type custom section, not by any code in
// this file:
//
//   1. The host calls it to get space in *our* linear memory before writing
//      an argument string in (e.g. the `input` string of
//      `images-make-thumbnail`).
//   2. The canon-lower trampoline for our `images` import calls it to get
//      space for a *returned* string, before copying the host's reply bytes
//      into our memory.
//
// Preview 2's single core module has exactly one of these, with exactly this
// signature: `(ptr, old_size, align, new_size) -> ptr`. `align` and
// `old_size` describe the *existing* allocation (0/0 for a fresh one);
// `new_size` of 0 means "free".
export fn cabi_realloc(
    ptr: ?[*]u8,
    old_size: usize,
    alignment: usize,
    new_size: usize,
) callconv(.c) ?[*]u8 {
    const a = std.mem.Alignment.fromByteUnits(alignment);

    if (new_size == 0) {
        if (ptr) |p| {
            if (old_size != 0) allocator.rawFree(p[0..old_size], a, @returnAddress());
        }
        // The Canonical ABI never dereferences a zero-size allocation; any
        // non-null value satisfies callers that only compare it to null.
        return @ptrFromInt(alignment);
    }

    if (ptr) |p| {
        if (old_size != 0) {
            if (allocator.rawRemap(p[0..old_size], a, new_size, @returnAddress())) |grown| {
                return grown;
            }
            const fresh = allocator.rawAlloc(new_size, a, @returnAddress()) orelse
                @panic("cabi_realloc: out of memory");
            const copy_len = @min(old_size, new_size);
            @memcpy(fresh[0..copy_len], p[0..copy_len]);
            allocator.rawFree(p[0..old_size], a, @returnAddress());
            return fresh;
        }
    }

    return allocator.rawAlloc(new_size, a, @returnAddress()) orelse
        @panic("cabi_realloc: out of memory");
}

/// Frees a byte buffer obtained through `cabi_realloc` (directly, or via the
/// host writing into space it requested from us). Every buffer this guest
/// ever frees holds JSON string bytes, which the Canonical ABI's `string`
/// element type aligns to 1 — so every call site below passes `alignment: 1`.
/// A future world with non-string payloads would need to plumb the real
/// alignment through instead of assuming it.
fn freeBytes(ptr: [*]const u8, len: usize, alignment: usize) void {
    if (len == 0) return;
    const mutable: [*]u8 = @constCast(ptr);
    allocator.rawFree(mutable[0..len], .fromByteUnits(alignment), @returnAddress());
}

// An out-of-memory condition below always panics (traps) rather than
// returning an `err` payload: it is an infrastructure fault with unknown
// certainty, not a declared domain error. See the module doc comment on
// `wit.rs` in the host crate for that distinction.
fn oom() noreturn {
    @panic("out of memory");
}

// ============================================================================
// Import: `footprints.images` — the host function that gives this guest the
// only fact it is allowed to know about a source image: its pixel
// dimensions. This is the authority boundary made real: nothing in this
// guest can decode an image, so it must ask.
// ============================================================================
//
// Core wasm import signature, per the Canonical ABI's flattening rules for
// `func(request: string) -> result<string, string>`:
//   param 0: request string ptr
//   param 1: request string len
//   param 2: ptr to a 12-byte, 4-byte-aligned return area the *caller*
//            (this guest) allocates, that the host writes into.
// There is no flat return value: `result<string, string>` flattens to more
// than the single core value Preview 2's MAX_FLAT_RESULTS allows, so the
// result is always indirect — for an import, indirect means the caller
// supplies the space.
extern "boundary:guest/footprints@1.0.0" fn images(
    request_ptr: [*]const u8,
    request_len: usize,
    return_area: [*]u8,
) void;

/// One `footprints.images` call's outcome. Both variants borrow host-written
/// bytes living in *our* linear memory (the host used our `cabi_realloc` to
/// place them there) — the caller owns them and must free them with
/// `freeBytes(.., .., 1)` once done reading.
const SourceReply = union(enum) {
    ok: []const u8,
    err: []const u8,
};

fn callImages(request: []const u8) SourceReply {
    // 12 bytes: a 1-byte discriminant (padded to 4), then a 4-byte ptr and a
    // 4-byte len for whichever string variant the host chose. This buffer
    // only needs to outlive the single synchronous `images` call below, so a
    // stack local is fine — unlike the export's return area, nothing reads
    // it after this function returns.
    var reply_area: [12]u8 align(4) = undefined;
    images(request.ptr, request.len, &reply_area);

    const tag = reply_area[0];
    const ptr_addr = std.mem.readInt(u32, reply_area[4..8], .little);
    const len = std.mem.readInt(u32, reply_area[8..12], .little);
    const bytes: [*]const u8 = @ptrFromInt(ptr_addr);
    const slice = bytes[0..len];

    return if (tag == 0) .{ .ok = slice } else .{ .err = slice };
}

// ============================================================================
// Export: `images-make-thumbnail`
// ============================================================================
//
// Core wasm export signature: `(input_ptr: i32, input_len: i32) -> i32`.
// `result<string, string>` again exceeds MAX_FLAT_RESULTS, but for an
// *export* the indirection runs the other way: the callee (this guest)
// allocates the return area and hands back a single pointer to it, which the
// host reads synchronously before calling `cabi_post_images-make-thumbnail`
// with that same pointer so we can free what we allocated for the string
// payload.
//
// That last step is why this return area is a `var` at module scope rather
// than a stack local like `reply_area` above: `cabi_post` is a second,
// separate export call that runs *after* `images-make-thumbnail` has already
// returned, so anything living on that call's stack frame would be gone (or
// worse, silently overwritten) by the time `cabi_post` reads it.
var export_return_area: [12]u8 align(4) = undefined;

fn writeReturnArea(tag: u8, payload: []const u8) i32 {
    export_return_area[0] = tag;
    std.mem.writeInt(u32, export_return_area[4..8], @intCast(@intFromPtr(payload.ptr)), .little);
    std.mem.writeInt(u32, export_return_area[8..12], @intCast(payload.len), .little);
    return @bitCast(@as(u32, @intCast(@intFromPtr(&export_return_area))));
}

fn errOut(message: []const u8) i32 {
    const encoded = domain.encodeError(allocator, message) catch oom();
    return writeReturnArea(1, encoded);
}

fn errOutFmt(comptime fmt: []const u8, args: anytype) i32 {
    const message = allocator.print(fmt, args) catch oom();
    defer allocator.free(message);
    return errOut(message);
}

export fn @"images-make-thumbnail"(input_ptr: [*]const u8, input_len: usize) callconv(.c) i32 {
    const input_bytes = input_ptr[0..input_len];
    defer freeBytes(input_ptr, input_len, 1);

    const parsed_input = domain.parseInput(allocator, input_bytes) catch |e| {
        return errOutFmt("invalid input: {s}", .{@errorName(e)});
    };
    defer parsed_input.deinit();
    const input = parsed_input.value;

    const request_bytes = domain.encodeSourceRequest(allocator, input.imageId) catch oom();
    defer allocator.free(request_bytes);

    switch (callImages(request_bytes)) {
        .err => |err_bytes| {
            defer freeBytes(err_bytes.ptr, err_bytes.len, 1);

            const parsed_err = domain.parseErrorPayload(allocator, err_bytes) catch {
                return errOut("source image lookup failed");
            };
            defer parsed_err.deinit();

            return errOutFmt("source image lookup failed: {s}", .{parsed_err.value.@"error"});
        },
        .ok => |ok_bytes| {
            defer freeBytes(ok_bytes.ptr, ok_bytes.len, 1);

            const parsed_dims = domain.parseSourceDimensions(allocator, ok_bytes) catch {
                return errOut("malformed source dimensions from host");
            };
            defer parsed_dims.deinit();

            const dims = domain.thumbnailDimensions(parsed_dims.value, input.maxWidth) catch |e| {
                return errOut(@errorName(e));
            };

            const output = domain.encodeOutput(allocator, .{
                .imageId = input.imageId,
                .width = dims.width,
                .height = dims.height,
            }) catch oom();

            return writeReturnArea(0, output);
        },
    }
}

/// Post-return cleanup for `images-make-thumbnail`. The host calls this
/// exactly once, immediately after it has finished reading the string this
/// export returned, and before making any other call into this instance. Its
/// only job is to free what the export allocated for that string — the
/// return area itself is static, not heap memory, so there is nothing to
/// free there.
export fn @"cabi_post_images-make-thumbnail"(ptr: i32) callconv(.c) void {
    const addr: u32 = @bitCast(ptr);
    const area: [*]const u8 = @ptrFromInt(addr);
    const data_addr = std.mem.readInt(u32, area[4..8], .little);
    const len = std.mem.readInt(u32, area[8..12], .little);
    freeBytes(@ptrFromInt(data_addr), len, 1);
}
