//! Emits the WIT world for a small program so the real component toolchain can
//! parse it. Run: `cargo run -p boundary-plugin --example emit-wit`.
#![allow(clippy::expect_used)]

use boundary_core::{InteractionContract, InteractionDescriptor, PortableSchema, Program};
use boundary_plugin::{WitProjectionOptions, project_wit};
use serde_json::json;

fn main() {
    let input = PortableSchema::from_value(json!({
        "type": "object",
        "properties": {
            "imageId": { "type": "string" },
            "maxWidth": { "type": "integer" }
        },
        "required": ["imageId", "maxWidth"],
        "additionalProperties": false
    }))
    .expect("input schema");
    let output = PortableSchema::from_value(json!({
        "type": "object",
        "properties": {
            "imageId": { "type": "string" },
            "width": { "type": "integer" },
            "height": { "type": "integer" }
        },
        "required": ["imageId", "width", "height"],
        "additionalProperties": false
    }))
    .expect("output schema");

    let thumbnail = InteractionContract::builder("images.makeThumbnail", input, output)
        .reads(["images"])
        .changes(["images"])
        .finish()
        .expect("thumbnail contract");

    let program = Program::builder()
        .descriptor(
            InteractionDescriptor::builder(thumbnail)
                .finish()
                .expect("descriptor"),
        )
        .expect("descriptor accepted")
        .finish()
        .expect("program");

    let projection = project_wit(&program, &WitProjectionOptions::default()).expect("projection");
    print!("{}", projection.wit);
}
