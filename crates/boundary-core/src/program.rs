//! Handler-free interaction contracts and deterministic program identity.

mod canonical;
mod compatibility;
mod contract;
mod delta;
mod descriptor;
mod draft;
mod error;
mod id;
mod schema;
mod schema_compatibility;
#[cfg(feature = "schemars")]
mod schema_schemars;
mod timestamp;

pub use canonical::canonical_json;

/// Parses portable JSON while rejecting duplicate keys and invalid values.
///
/// # Errors
/// Returns an error for non-portable or malformed JSON.
pub fn parse_portable_json(source: &str) -> Result<serde_json::Value, ProgramError> {
    canonical::parse_strict_json(source)
}

pub use compatibility::{Compatibility, contract_compatibility};
pub use contract::{InteractionContract, InteractionContractBuilder};
pub use delta::{ChangeKind, ContractChange, ContractDelta, contract_changes};
pub(crate) use descriptor::descriptor_for;
pub use descriptor::{
    InteractionDescriptor, InteractionDescriptorBuilder, InteractionDocumentation, Program,
    ProgramBuilder,
};
pub use draft::Draft;
pub use error::{ProgramError, ProgramErrorCode};
pub use id::{ContractDigest, DraftDigest, InteractionId, ProgramDigest, StaticInteractionId};
pub use schema::{PortableSchema, SchemaType};

/// Returns whether `value` is a valid v1 interaction identifier.
///
/// This function is public only so [`interaction_id!`] can validate literals at
/// compile time. Prefer [`InteractionId::parse`] for dynamic input.
#[doc(hidden)]
#[must_use]
pub const fn __valid_interaction_id(value: &str) -> bool {
    id::valid_interaction_id(value)
}

/// Creates a statically stored interaction identifier after compile-time validation.
///
/// ```
/// use boundary_core::{StaticInteractionId, interaction_id};
/// const LIST: StaticInteractionId = interaction_id!("todos.list");
/// assert_eq!(LIST.as_str(), "todos.list");
/// ```
///
/// Invalid literals fail during compilation:
///
/// ```compile_fail
/// use boundary_core::{StaticInteractionId, interaction_id};
/// const BAD: StaticInteractionId = interaction_id!("todos create");
/// ```
#[macro_export]
macro_rules! interaction_id {
    ($value:literal) => {{
        const _: () = assert!(
            $crate::__valid_interaction_id($value),
            "interaction id must be an ASCII token of 1..=128 characters"
        );
        $crate::StaticInteractionId::__new_validated($value)
    }};
}
