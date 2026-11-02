use boundary_core::lifecycle::{
    NativeInteraction, ProjectionModes, RealizationId, RequestControlDigest, RequestIdentity,
};
use boundary_core::{
    InputArity, InteractionContract, InteractionDescriptor, PortableSchema, parse_portable_json,
};
use std::ffi::c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Slice {
    pub ptr: *const u8,
    pub len: usize,
}
#[repr(C)]
pub struct Buffer {
    pub ptr: *mut u8,
    pub len: usize,
}
#[repr(C)]
pub struct Interaction {
    pub struct_size: usize,
    pub id: Slice,
    pub alias: Slice,
    pub input_schema: Slice,
    pub output_schema: Slice,
    pub error_schema: Slice,
    pub reads: Slice,
    pub changes: Slice,
    pub input_arity: u32,
    pub modes: u32,
    pub direct_realization_id: Slice,
    pub request_realization_id: Slice,
    pub request_control_digest: Slice,
    pub request_preview_schema: Slice,
}
pub(crate) type Admit = unsafe extern "C" fn(*mut c_void, *mut c_void, Slice, u32, Slice) -> i32;
pub(crate) type Dispatch =
    unsafe extern "C" fn(*mut c_void, *mut c_void, Slice, u32, Slice, *mut Slice) -> i32;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Callbacks {
    pub struct_size: usize,
    pub userdata: *mut c_void,
    pub admit: Option<Admit>,
    pub dispatch: Option<Dispatch>,
}
#[derive(Clone)]
pub(crate) struct Definition {
    pub native: NativeInteraction,
    pub alias: String,
    pub modes: Option<ProjectionModes>,
    pub direct: Option<RealizationId>,
    pub request: Option<(RealizationId, RequestIdentity)>,
}

// SAFETY: the caller promises the input slice points to readable bytes during the call.
pub(crate) unsafe fn text<'a>(s: Slice) -> Result<&'a str, i32> {
    if s.len > 16 * 1024 * 1024 || (s.ptr.is_null() && s.len != 0) {
        return Err(1);
    }
    if s.len == 0 {
        return Ok("");
    }
    let bytes = unsafe { std::slice::from_raw_parts(s.ptr, s.len) };
    std::str::from_utf8(bytes).map_err(|_| 2)
}
pub(crate) fn view(s: &str) -> Slice {
    Slice {
        ptr: s.as_ptr(),
        len: s.len(),
    }
}
pub(crate) fn encode(value: &impl ToString) -> Buffer {
    let bytes = value.to_string().into_bytes().into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes).cast::<u8>();
    Buffer { ptr, len }
}
fn schema(s: &str) -> Result<PortableSchema, i32> {
    PortableSchema::from_json_str(s).map_err(|_| 2)
}
// SAFETY: every field is borrowed from the caller for this call only.
pub(crate) unsafe fn definition(raw: &Interaction) -> Result<Definition, i32> {
    let id = unsafe { text(raw.id)? };
    let alias = unsafe { text(raw.alias)? };
    let input = schema(unsafe { text(raw.input_schema)? })?;
    let output = schema(unsafe { text(raw.output_schema)? })?;
    // Zero arity uses the exact portable EmptyObjectCodec schema; rejecting a
    // broader declaration avoids changing its contract or admitting other input.
    if raw.input_arity == 0
        && input.as_value()
            != &serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false})
    {
        return Err(2);
    }
    let reads: Vec<String> =
        serde_json::from_value(parse_portable_json(unsafe { text(raw.reads)? }).map_err(|_| 2)?)
            .map_err(|_| 2)?;
    let changes: Vec<String> =
        serde_json::from_value(parse_portable_json(unsafe { text(raw.changes)? }).map_err(|_| 2)?)
            .map_err(|_| 2)?;
    let mut builder = InteractionContract::builder(id, input, output)
        .reads(reads)
        .changes(changes);
    let error = unsafe { text(raw.error_schema)? };
    if !error.is_empty() {
        builder = builder.error_schema(schema(error)?);
    }
    let descriptor = InteractionDescriptor::builder(builder.finish().map_err(|_| 2)?)
        .finish()
        .map_err(|_| 2)?;
    let arity = match raw.input_arity {
        0 => InputArity::Zero,
        1 => InputArity::One,
        _ => return Err(1),
    };
    let modes = match raw.modes {
        0 => None,
        1 => Some(ProjectionModes::Direct),
        2 => Some(ProjectionModes::Request),
        3 => Some(ProjectionModes::DirectAndRequest),
        _ => return Err(1),
    };
    let direct = if raw.modes & 1 != 0 {
        Some(RealizationId::new(unsafe { text(raw.direct_realization_id)? }).map_err(|_| 2)?)
    } else {
        None
    };
    let request = if raw.modes & 2 != 0 {
        Some((
            RealizationId::new(unsafe { text(raw.request_realization_id)? }).map_err(|_| 2)?,
            RequestIdentity::new(
                RequestControlDigest::parse(unsafe { text(raw.request_control_digest)? })
                    .map_err(|_| 2)?,
                schema(unsafe { text(raw.request_preview_schema)? })?,
            ),
        ))
    } else {
        None
    };
    Ok(Definition {
        native: NativeInteraction::new(descriptor, arity),
        alias: alias.to_owned(),
        modes,
        direct,
        request,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn borrowed(s: &str) -> Slice {
        view(s)
    }
    #[test]
    fn zero_arity_rejects_broad_schema_and_accepts_exact_empty_object() {
        let mut raw = Interaction {
            struct_size: std::mem::size_of::<Interaction>(),
            id: borrowed("test.zero"),
            alias: borrowed("zero"),
            input_schema: borrowed("{}"),
            output_schema: borrowed("{}"),
            error_schema: borrowed(""),
            reads: borrowed("[]"),
            changes: borrowed("[]"),
            input_arity: 0,
            modes: 0,
            direct_realization_id: borrowed(""),
            request_realization_id: borrowed(""),
            request_control_digest: borrowed(""),
            request_preview_schema: borrowed(""),
        };
        // SAFETY: all borrowed strings and the struct are live for both calls.
        assert!(unsafe { definition(&raw) }.is_err());
        raw.input_schema = borrowed(
            r#"{"type":"object","properties":{},"required":[],"additionalProperties":false}"#,
        );
        // SAFETY: the canonical schema is a static string.
        assert!(unsafe { definition(&raw) }.is_ok());
    }
}
