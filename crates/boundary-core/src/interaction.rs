//! Native interaction and realization authoring traits.

use std::future::Future;

use serde_json::{Map, Value};

use crate::{
    codec::{DeclaredErrorCodec, PortableFault, WireCodec},
    program::StaticInteractionId,
};

/// Number of logical interaction inputs at a dynamic boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputArity {
    /// The request is represented by the canonical empty object `{}`.
    Zero,
    /// The request is represented by one portable value.
    One,
}

/// Documentation excluded from interaction identity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InteractionDocs {
    /// One-line summary.
    pub summary: &'static str,
    /// Longer explanation.
    pub description: &'static str,
}

/// A complete read footprint for a read-only interaction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReadFootprint {
    reads: &'static [&'static str],
}

impl ReadFootprint {
    /// Declares the resources read by an interaction.
    #[must_use]
    pub const fn new(reads: &'static [&'static str]) -> Self {
        Self { reads }
    }
}

/// Complete read/change footprints for a state-changing interaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangeFootprint {
    reads: &'static [&'static str],
    changes: &'static [&'static str],
}

impl ChangeFootprint {
    /// Declares all resources read and changed by an interaction.
    #[must_use]
    pub const fn new(reads: &'static [&'static str], changes: &'static [&'static str]) -> Self {
        Self { reads, changes }
    }
}

mod effect_sealed {
    pub trait Sealed {}
}

/// Type-level interaction effect class.
pub trait EffectClass: effect_sealed::Sealed + Send + Sync + 'static {
    /// Footprint form accepted by this effect class.
    type Footprint: Copy + Send + Sync + 'static;

    /// Splits the footprint into Program contract fields.
    fn parts(footprint: Self::Footprint) -> FootprintParts;
}

/// Read-only interaction effect marker.
#[derive(Debug, Clone, Copy)]
pub enum ReadOnly {}

/// State-changing interaction effect marker.
#[derive(Debug, Clone, Copy)]
pub enum ChangesState {}

impl effect_sealed::Sealed for ReadOnly {}
impl effect_sealed::Sealed for ChangesState {}

impl EffectClass for ReadOnly {
    type Footprint = ReadFootprint;

    fn parts(footprint: Self::Footprint) -> FootprintParts {
        FootprintParts {
            reads: footprint.reads,
            changes: &[],
        }
    }
}

impl EffectClass for ChangesState {
    type Footprint = ChangeFootprint;

    fn parts(footprint: Self::Footprint) -> FootprintParts {
        FootprintParts {
            reads: footprint.reads,
            changes: footprint.changes,
        }
    }
}

/// Borrowed footprint fields used during Program compilation.
#[derive(Debug, Clone, Copy)]
pub struct FootprintParts {
    /// Declared read resources.
    pub reads: &'static [&'static str],
    /// Declared changed resources.
    pub changes: &'static [&'static str],
}

/// A native interaction. The request struct itself implements this trait.
pub trait Interaction: Sized + Send + 'static {
    /// Stable interaction identifier.
    const ID: StaticInteractionId;
    /// Dynamic-boundary request arity.
    const INPUT_ARITY: InputArity = InputArity::One;

    /// Successful native result.
    type Output: Send + 'static;
    /// Declared native domain error.
    type Error: PortableFault;
    /// Type-level effect classification.
    type Effect: EffectClass;
    /// Request boundary codec.
    type InputCodec: WireCodec<Self>;
    /// Result boundary codec.
    type OutputCodec: WireCodec<Self::Output>;
    /// Declared error boundary codec.
    type ErrorCodec: DeclaredErrorCodec<Self::Error>;

    /// Returns complete resource footprints.
    fn footprint() -> <Self::Effect as EffectClass>::Footprint;

    /// Returns presentation-only documentation.
    #[must_use]
    fn docs() -> InteractionDocs {
        InteractionDocs::default()
    }

    /// Returns presentation-only annotations.
    #[must_use]
    fn annotations() -> Value {
        Value::Object(Map::new())
    }
}

/// A native realization borrowing the exact call context.
pub trait Handler<O, Context = ()>: Send + Sync + 'static
where
    O: Interaction,
    Context: Sync + ?Sized,
{
    /// Executes one interaction value.
    fn handle<'a>(
        &'a self,
        context: &'a Context,
        interaction: O,
    ) -> impl Future<Output = Result<O::Output, O::Error>> + Send + 'a;
}
