#![doc = "Native Rust foundations for interaction-first software."]
#![forbid(unsafe_code)]

mod codec;
pub mod control;
pub mod evidence;
pub mod handoff;
mod interaction;
pub mod lifecycle;
pub mod observations;
pub mod plan;
mod program;

pub use codec::{
    DeclaredErrorCodec, EmptyObjectCodec, JsonCodec, NoError, PortableFault, WireCodec, WireError,
};
pub use interaction::{
    ChangeFootprint, ChangesState, EffectClass, FootprintParts, Handler, InputArity, Interaction,
    InteractionDocs, ReadFootprint, ReadOnly,
};
pub use program::{
    __valid_interaction_id, ChangeKind, Compatibility, ContractChange, ContractDelta,
    ContractDigest, Draft, DraftDigest, InteractionContract, InteractionContractBuilder,
    InteractionDescriptor, InteractionDescriptorBuilder, InteractionDocumentation, InteractionId,
    PortableSchema, Program, ProgramBuilder, ProgramDigest, ProgramError, ProgramErrorCode,
    SchemaType, StaticInteractionId, canonical_json, contract_changes, contract_compatibility,
    parse_portable_json,
};

#[cfg(feature = "derive")]
pub use boundary_macros::{Fault, Interaction};
