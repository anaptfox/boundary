//! Portable boundary codecs.

use std::{error::Error, fmt, marker::PhantomData};

use serde_json::{Map, Value};
use thiserror::Error;

use crate::program::PortableSchema;

#[cfg(feature = "schemars")]
mod compiled;
#[cfg(feature = "schemars")]
mod envelope;

#[cfg(feature = "schemars")]
use serde::{Serialize, de::DeserializeOwned};

/// Stable behavior required from a declared error exposed across a Handoff.
///
/// The code is part of the portable error vocabulary; display text and Rust
/// debug output are not.
pub trait PortableFault: Error + Send + Sync + 'static {
    /// Returns the stable public code for this error variant.
    fn code(&self) -> &'static str;

    /// Whether the type's own Serde form is the portable `{ code, details }`
    /// envelope, that is, an enum marked `tag = "code", content = "details"`.
    ///
    /// `#[derive(Fault)]` sets this for such enums. [`JsonCodec`] then declares
    /// the enum's schema directly as the contract `errorSchema` and carries the
    /// content as `details`, with no second wrapper. Otherwise the whole
    /// serialized error is `details` under a generic nonempty-code envelope.
    const ENVELOPE: bool = false;
}

/// Converts one native Rust type to and from its portable wire form.
///
/// Implementations may use a distinct wire DTO. The native type itself does
/// not need to implement Serde or Schemars.
pub trait WireCodec<T>: Send + Sync + 'static {
    /// Compiles the portable schema for the encoded value.
    ///
    /// # Errors
    ///
    /// Returns a schema error when the codec cannot express its wire form in
    /// the bounded portable schema profile.
    fn schema() -> Result<PortableSchema, WireError>;

    /// Encodes a native value without exposing implementation details.
    ///
    /// # Errors
    ///
    /// Returns an encoding error when the value has no portable representation.
    fn encode(value: &T) -> Result<Value, WireError>;

    /// Decodes and validates a portable value.
    ///
    /// # Errors
    ///
    /// Returns a decoding error when the portable value is invalid.
    fn decode(value: Value) -> Result<T, WireError>;

    /// Produces the single normalized value used by authorization and dispatch.
    ///
    /// # Errors
    ///
    /// Returns a boundary error when decoding or re-encoding fails.
    fn normalize(value: Value) -> Result<Value, WireError> {
        let decoded = Self::decode(value)?;
        Self::encode(&decoded)
    }
}

/// Serde/Schemars convenience codec for types whose native and wire forms are
/// identical.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec<T>(PhantomData<fn() -> T>);

/// Canonical `{}` codec for a zero-input interaction request type.
///
/// The request type remains the interaction and is constructed with `Default`;
/// no public placeholder input value is introduced.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmptyObjectCodec<T>(PhantomData<fn() -> T>);

impl<T> WireCodec<T> for EmptyObjectCodec<T>
where
    T: Default + Send + 'static,
{
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(serde_json::json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(_value: &T) -> Result<Value, WireError> {
        Ok(Value::Object(Map::new()))
    }

    fn decode(value: Value) -> Result<T, WireError> {
        match value {
            Value::Object(object) if object.is_empty() => Ok(T::default()),
            _ => Err(WireError::Decode(
                "zero-input interactions require an empty object".to_owned(),
            )),
        }
    }
}

#[cfg(feature = "schemars")]
impl<T> WireCodec<T> for JsonCodec<T>
where
    T: Serialize + DeserializeOwned + schemars::JsonSchema + Send + 'static,
{
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::for_type::<T>().map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &T) -> Result<Value, WireError> {
        serde_json::to_value(value).map_err(|error| WireError::encode(&error))
    }

    fn decode(value: Value) -> Result<T, WireError> {
        // The portable contract is the trust boundary: judge the value against
        // it first so serde never accepts what the contract refuses.
        if !compiled::compiled_schema::<T>()?.accepts(&value) {
            return Err(WireError::Decode(
                "value does not satisfy the portable schema".to_owned(),
            ));
        }
        serde_json::from_value(value).map_err(|error| WireError::decode(&error))
    }
}

/// A codec for a declared, portable interaction error.
pub trait DeclaredErrorCodec<E>: Send + Sync + 'static {
    /// Compiles the native details schema. `None` means the interaction cannot
    /// return a declared domain error. This schema describes `details`, not the
    /// portable `{ code, details }` declaration.
    ///
    /// # Errors
    ///
    /// Returns a schema error when the declared error has no portable schema.
    fn schema() -> Result<Option<PortableSchema>, WireError>;

    /// Compiles the portable contract `errorSchema` for the complete
    /// `{ code, details }` value, the same shape TypeScript declares and checks.
    ///
    /// The default admits any nonempty code with the native details schema.
    /// Override it to declare a finite code vocabulary or code-specific details.
    ///
    /// # Errors
    ///
    /// Returns a schema error when the declaration is not portable.
    fn declared_schema() -> Result<Option<PortableSchema>, WireError> {
        Self::schema()?.map_or(Ok(None), |details| wrap_details(&details))
    }

    /// Encodes the native details of a declared domain error.
    ///
    /// # Errors
    ///
    /// Returns an encoding error when the error has no portable representation.
    fn encode(error: &E) -> Result<Value, WireError>;

    /// Decodes a declared domain error.
    ///
    /// # Errors
    ///
    /// Returns a decoding error when the portable error is invalid.
    fn decode(value: Value) -> Result<E, WireError>;

    /// Reconstructs an error from its portable code and native details.
    ///
    /// The default decodes self-describing details. Override it when the wire
    /// code supplies the native variant discriminant. Boundary separately
    /// verifies that the reconstructed error's public code matches `code`.
    ///
    /// # Errors
    ///
    /// Returns a decoding error when the code or details cannot be represented.
    fn decode_declared(_code: &str, details: Value) -> Result<E, WireError> {
        Self::decode(details)
    }

    /// Produces the single normalized native details value.
    ///
    /// # Errors
    ///
    /// Returns a boundary error when decoding or re-encoding fails.
    fn normalize(value: Value) -> Result<Value, WireError> {
        let decoded = Self::decode(value)?;
        Self::encode(&decoded)
    }

    /// Normalizes details using the complete declared error's discriminant.
    ///
    /// Portable dispatch uses this instead of [`Self::normalize`], since details
    /// need not identify a native variant without `code`. The default
    /// reconstructs with [`Self::decode_declared`] and re-encodes. A codec with
    /// a custom details-only normalization rule must override it.
    ///
    /// # Errors
    ///
    /// Returns a boundary error when decoding or re-encoding fails.
    fn normalize_declared(code: &str, details: Value) -> Result<Value, WireError> {
        let decoded = Self::decode_declared(code, details)?;
        Self::encode(&decoded)
    }
}

/// The generic envelope: any nonempty code with the native details schema.
fn wrap_details(details: &PortableSchema) -> Result<Option<PortableSchema>, WireError> {
    PortableSchema::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "code": { "type": "string", "minLength": 1 },
            "details": details.as_value()
        },
        "required": ["code", "details"],
        "additionalProperties": false
    }))
    .map(Some)
    .map_err(|error| WireError::Schema(error.to_string()))
}

pub(crate) fn decode_declared<E, C>(code: &str, details: Value) -> Result<E, WireError>
where
    E: PortableFault,
    C: DeclaredErrorCodec<E>,
{
    let error = C::decode_declared(code, details)?;
    if error.code() != code {
        return Err(WireError::Decode(
            "declared code does not match the reconstructed native error".to_owned(),
        ));
    }
    Ok(error)
}

pub(crate) fn normalize_declared<E, C>(code: &str, details: Value) -> Result<Value, WireError>
where
    E: PortableFault,
    C: DeclaredErrorCodec<E>,
{
    let details = C::normalize_declared(code, details)?;
    decode_declared::<E, C>(code, details.clone())?;
    Ok(details)
}

#[cfg(feature = "schemars")]
impl<E> DeclaredErrorCodec<E> for JsonCodec<E>
where
    E: PortableFault + Serialize + DeserializeOwned + schemars::JsonSchema,
{
    fn schema() -> Result<Option<PortableSchema>, WireError> {
        <Self as WireCodec<E>>::schema().map(Some)
    }

    fn declared_schema() -> Result<Option<PortableSchema>, WireError> {
        if E::ENVELOPE {
            envelope::declared_schema::<E, Self>()
        } else {
            wrap_details(&<Self as WireCodec<E>>::schema()?)
        }
    }

    fn encode(error: &E) -> Result<Value, WireError> {
        if E::ENVELOPE {
            envelope::check_code(error)?;
            envelope::encode(error)
        } else {
            <Self as WireCodec<E>>::encode(error)
        }
    }

    /// Decodes the native serialized form: the whole error, or for an envelope
    /// error the `{ code, details }` object.
    fn decode(value: Value) -> Result<E, WireError> {
        <Self as WireCodec<E>>::decode(value)
    }

    fn decode_declared(code: &str, details: Value) -> Result<E, WireError> {
        if E::ENVELOPE {
            envelope::decode::<E, Self>(code, details)
        } else {
            <Self as WireCodec<E>>::decode(details)
        }
    }
}

/// An uninhabited domain error for interactions that cannot fail declaratively.
#[derive(Debug)]
pub enum NoError {}

impl fmt::Display for NoError {
    fn fmt(&self, _formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {}
    }
}

impl Error for NoError {}

impl PortableFault for NoError {
    fn code(&self) -> &'static str {
        match *self {}
    }
}

impl DeclaredErrorCodec<NoError> for NoError {
    fn schema() -> Result<Option<PortableSchema>, WireError> {
        Ok(None)
    }

    fn encode(error: &NoError) -> Result<Value, WireError> {
        match *error {}
    }

    fn decode(_value: Value) -> Result<NoError, WireError> {
        Err(WireError::UndeclaredError)
    }
}

/// A portable boundary codec failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum WireError {
    /// The portable schema could not be compiled.
    #[error("portable schema compilation failed: {0}")]
    Schema(String),
    /// A native value could not be encoded.
    #[error("wire encoding failed: {0}")]
    Encode(String),
    /// A portable value could not be decoded.
    #[error("wire decoding failed: {0}")]
    Decode(String),
    /// A boundary supplied an error for an infallible interaction.
    #[error("interaction does not declare a portable domain error")]
    UndeclaredError,
}

#[cfg(feature = "schemars")]
impl WireError {
    fn encode(error: &serde_json::Error) -> Self {
        Self::Encode(error.to_string())
    }

    fn decode(error: &serde_json::Error) -> Self {
        Self::Decode(error.to_string())
    }
}
