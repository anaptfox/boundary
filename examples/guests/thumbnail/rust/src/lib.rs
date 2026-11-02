//! Rust guest realizing `images.makeThumbnail`. Arithmetic only; no codecs.
#![allow(warnings)]
mod bindings;

use bindings::boundary::guest::footprints;
use bindings::Guest;
use serde_json::{json, Value};

struct Component;

fn error_payload(message: &str) -> String {
    json!({ "error": message }).to_string()
}

fn thumbnail_dimensions(width: u64, height: u64, max_width: i64) -> Result<(u32, u32), String> {
    if max_width <= 0 {
        return Err(error_payload("invalid max width"));
    }
    if width == 0 || height == 0 {
        return Err(error_payload("invalid source dimensions"));
    }
    let requested = u64::try_from(max_width).unwrap_or(u64::from(u32::MAX));
    let out_w = requested.min(width);
    let out_h = (height * out_w + width / 2) / width;
    let out_h = out_h.max(1);
    let width = u32::try_from(out_w).map_err(|_| error_payload("width overflow"))?;
    let height = u32::try_from(out_h).map_err(|_| error_payload("height overflow"))?;
    Ok((width, height))
}

impl Guest for Component {
    fn images_make_thumbnail(input: String) -> Result<String, String> {
        let parsed: Value =
            serde_json::from_str(&input).map_err(|error| error_payload(&error.to_string()))?;
        let image_id = parsed
            .get("imageId")
            .and_then(Value::as_str)
            .ok_or_else(|| error_payload("imageId is required"))?;
        let max_width = parsed
            .get("maxWidth")
            .and_then(Value::as_i64)
            .ok_or_else(|| error_payload("maxWidth is required"))?;
        let request = json!({ "imageId": image_id }).to_string();
        let reply = footprints::images(&request).map_err(|error| {
            if error.is_empty() {
                error_payload("source image lookup failed")
            } else {
                error
            }
        })?;
        let source: Value =
            serde_json::from_str(&reply).map_err(|error| error_payload(&error.to_string()))?;
        let width = source
            .get("width")
            .and_then(Value::as_u64)
            .ok_or_else(|| error_payload("source width is required"))?;
        let height = source
            .get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| error_payload("source height is required"))?;
        let (out_w, out_h) = thumbnail_dimensions(width, height, max_width)?;
        Ok(json!({
            "imageId": image_id,
            "width": out_w,
            "height": out_h,
        })
        .to_string())
    }
}

bindings::export!(Component with_types_in bindings);
