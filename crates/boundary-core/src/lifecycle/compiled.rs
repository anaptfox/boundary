use std::{fmt, marker::PhantomData};

use crate::{
    ContractDigest, InputArity, Interaction, InteractionDescriptor, InteractionId, ProgramError,
    program::descriptor_for,
};

/// An owned, typed, handler-free interaction compiled for projection or installation.
pub struct CompiledInteraction<O: Interaction> {
    descriptor: InteractionDescriptor,
    input_arity: InputArity,
    _interaction: PhantomData<fn(O)>,
}

impl<O: Interaction> CompiledInteraction<O> {
    /// Returns the complete portable descriptor.
    #[must_use]
    pub const fn descriptor(&self) -> &InteractionDescriptor {
        &self.descriptor
    }

    /// Returns the host-authored interaction identifier.
    #[must_use]
    pub fn interaction_id(&self) -> &InteractionId {
        self.descriptor.contract().id()
    }

    /// Returns the exact compiled contract digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        self.descriptor.contract_digest()
    }

    /// Returns whether the dynamic boundary accepts zero or one input value.
    #[must_use]
    pub const fn input_arity(&self) -> InputArity {
        self.input_arity
    }

    pub(super) fn erase(&self) -> ErasedInteraction {
        ErasedInteraction {
            descriptor: self.descriptor.clone(),
            input_arity: self.input_arity,
        }
    }
}

impl<O: Interaction> Clone for CompiledInteraction<O> {
    fn clone(&self) -> Self {
        Self {
            descriptor: self.descriptor.clone(),
            input_arity: self.input_arity,
            _interaction: PhantomData,
        }
    }
}

impl<O: Interaction> fmt::Debug for CompiledInteraction<O> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CompiledInteraction")
            .field("interaction_id", &self.interaction_id())
            .field("contract_digest", &self.contract_digest())
            .field("input_arity", &self.input_arity)
            .finish_non_exhaustive()
    }
}

/// Compiles one native definition without installing executable code.
///
/// # Errors
///
/// Returns [`ProgramError`] when codecs cannot produce a portable contract or
/// the declaration violates Program v1.
pub fn compile_interaction<O>() -> Result<CompiledInteraction<O>, ProgramError>
where
    O: Interaction,
{
    Ok(CompiledInteraction {
        descriptor: descriptor_for::<O>()?,
        input_arity: O::INPUT_ARITY,
        _interaction: PhantomData,
    })
}

#[derive(Clone, Debug)]
pub(super) struct ErasedInteraction {
    pub descriptor: InteractionDescriptor,
    pub input_arity: InputArity,
}

/// A host-authored portable interaction with dynamic input and realization types.
#[derive(Clone, Debug)]
pub struct NativeInteraction {
    pub(super) erased: ErasedInteraction,
}

impl NativeInteraction {
    /// Retains a validated descriptor and its host-declared input arity.
    #[must_use]
    pub const fn new(descriptor: InteractionDescriptor, input_arity: InputArity) -> Self {
        Self {
            erased: ErasedInteraction {
                descriptor,
                input_arity,
            },
        }
    }

    /// Returns the identity-bearing declaration.
    #[must_use]
    pub const fn descriptor(&self) -> &InteractionDescriptor {
        &self.erased.descriptor
    }
}
