//! Pure domain logic for the `images.makeThumbnail` interaction.
//!
//! Nothing in this file touches WebAssembly, linear memory, or the Canonical
//! ABI — it is plain Zig you could compile and test on any target, which is
//! the point: it is also the entire scope of what this guest does. It reads
//! two integers (a decoded source image's width and height, handed to it by
//! the host through the `images` import) and one integer (the caller's
//! requested max width), and returns two integers back. It never opens,
//! decodes, or encodes an image file. See ../README.md for why that line is
//! drawn here.
const std = @import("std");

/// The interaction's input, as parsed from the canonical-JSON `input` string.
pub const ThumbnailInput = struct {
    imageId: []const u8,
    maxWidth: i64,
};

/// The interaction's success payload, serialized back to canonical JSON.
pub const ThumbnailOutput = struct {
    imageId: []const u8,
    width: u32,
    height: u32,
};

/// The shape both this guest and the `images` host function use for their
/// `err` string payload. This is *not* part of the WIT contract — WIT only
/// says `result<string, string>` — it is this example's own envelope,
/// documented here because both ends of the import need to agree on it.
pub const ErrorPayload = struct {
    @"error": []const u8,
};

/// The reply shape for the `images` host import's `ok` case: the source
/// image's decoded pixel dimensions. The host already decoded the image
/// format; this is the only thing this guest is allowed to ask about it.
pub const SourceDimensions = struct {
    width: u32,
    height: u32,
};

/// The request shape this guest sends to the `images` host import.
pub const SourceRequest = struct {
    imageId: []const u8,
};

/// Domain errors from the arithmetic itself, independent of any host call.
pub const DimensionError = error{
    InvalidMaxWidth,
    InvalidSourceDimensions,
};

/// Scales `source` down to fit within `max_width`, preserving aspect ratio.
/// Never enlarges: a `max_width` at or above the source width returns the
/// source dimensions unchanged. Height is rounded to the nearest integer,
/// ties rounding up, and is never less than 1.
///
/// This is the entire "image processing" this guest performs: two multiplies,
/// a divide, and a min. No pixels are read or written.
pub fn thumbnailDimensions(source: SourceDimensions, max_width: i64) DimensionError!SourceDimensions {
    if (max_width <= 0) return error.InvalidMaxWidth;
    if (source.width == 0 or source.height == 0) return error.InvalidSourceDimensions;

    const src_w: u64 = source.width;
    const src_h: u64 = source.height;
    const requested: u64 = @intCast(@min(max_width, std.math.maxInt(u32)));

    const out_w = @min(requested, src_w);
    const out_h = @max(1, (src_h * out_w + src_w / 2) / src_w);

    return .{
        .width = @intCast(out_w),
        .height = @intCast(out_h),
    };
}

/// Parses the interaction's canonical-JSON input. `allocator` backs a
/// short-lived arena; call `.deinit()` on the result when done with it.
pub fn parseInput(allocator: std.mem.Allocator, bytes: []const u8) !std.json.Parsed(ThumbnailInput) {
    return std.json.parseFromSlice(ThumbnailInput, allocator, bytes, .{});
}

/// Parses the `images` import's `ok` reply.
pub fn parseSourceDimensions(allocator: std.mem.Allocator, bytes: []const u8) !std.json.Parsed(SourceDimensions) {
    return std.json.parseFromSlice(SourceDimensions, allocator, bytes, .{});
}

/// Parses an `err` payload — either the `images` import's or this guest's own
/// (they share the shape).
pub fn parseErrorPayload(allocator: std.mem.Allocator, bytes: []const u8) !std.json.Parsed(ErrorPayload) {
    return std.json.parseFromSlice(ErrorPayload, allocator, bytes, .{});
}

/// Encodes the interaction's success payload as canonical JSON.
pub fn encodeOutput(allocator: std.mem.Allocator, output: ThumbnailOutput) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, output, .{});
}

/// Encodes an `err` payload as canonical JSON.
pub fn encodeError(allocator: std.mem.Allocator, message: []const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, ErrorPayload{ .@"error" = message }, .{});
}

/// Encodes the request this guest sends to the `images` host import.
pub fn encodeSourceRequest(allocator: std.mem.Allocator, image_id: []const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, SourceRequest{ .imageId = image_id }, .{});
}

const testing = std.testing;

test "downscale preserves aspect ratio" {
    const result = try thumbnailDimensions(.{ .width = 1920, .height = 1080 }, 480);
    try testing.expectEqual(@as(u32, 480), result.width);
    try testing.expectEqual(@as(u32, 270), result.height);
}

test "max width at or above source keeps original size" {
    const at_source = try thumbnailDimensions(.{ .width = 800, .height = 600 }, 800);
    try testing.expectEqual(@as(u32, 800), at_source.width);
    try testing.expectEqual(@as(u32, 600), at_source.height);

    const above_source = try thumbnailDimensions(.{ .width = 800, .height = 600 }, 4000);
    try testing.expectEqual(@as(u32, 800), above_source.width);
    try testing.expectEqual(@as(u32, 600), above_source.height);
}

test "height rounds to nearest, ties up" {
    // 333 * 333 / 1000 = 110.889 -> 111
    const result = try thumbnailDimensions(.{ .width = 1000, .height = 333 }, 333);
    try testing.expectEqual(@as(u32, 333), result.width);
    try testing.expectEqual(@as(u32, 111), result.height);
}

test "rounded height is never zero" {
    const result = try thumbnailDimensions(.{ .width = 10_000, .height = 1 }, 1);
    try testing.expectEqual(@as(u32, 1), result.width);
    try testing.expectEqual(@as(u32, 1), result.height);
}

test "non-positive max width is a domain error" {
    try testing.expectError(error.InvalidMaxWidth, thumbnailDimensions(.{ .width = 100, .height = 100 }, 0));
    try testing.expectError(error.InvalidMaxWidth, thumbnailDimensions(.{ .width = 100, .height = 100 }, -1));
}

test "zero source dimensions is a domain error" {
    try testing.expectError(error.InvalidSourceDimensions, thumbnailDimensions(.{ .width = 0, .height = 100 }, 50));
    try testing.expectError(error.InvalidSourceDimensions, thumbnailDimensions(.{ .width = 100, .height = 0 }, 50));
}

test "input round-trips through JSON" {
    const parsed = try parseInput(testing.allocator, "{\"imageId\":\"img_1\",\"maxWidth\":480}");
    defer parsed.deinit();
    try testing.expectEqualStrings("img_1", parsed.value.imageId);
    try testing.expectEqual(@as(i64, 480), parsed.value.maxWidth);
}

test "output encodes canonical JSON" {
    const bytes = try encodeOutput(testing.allocator, .{ .imageId = "img_1", .width = 480, .height = 270 });
    defer testing.allocator.free(bytes);
    try testing.expectEqualStrings("{\"imageId\":\"img_1\",\"width\":480,\"height\":270}", bytes);
}

test "error payload encodes and parses back" {
    const bytes = try encodeError(testing.allocator, "unknown image id");
    defer testing.allocator.free(bytes);
    try testing.expectEqualStrings("{\"error\":\"unknown image id\"}", bytes);

    const parsed = try parseErrorPayload(testing.allocator, bytes);
    defer parsed.deinit();
    try testing.expectEqualStrings("unknown image id", parsed.value.@"error");
}

test "source request encodes the shared imageId shape" {
    const bytes = try encodeSourceRequest(testing.allocator, "img_1");
    defer testing.allocator.free(bytes);
    try testing.expectEqualStrings("{\"imageId\":\"img_1\"}", bytes);
}
