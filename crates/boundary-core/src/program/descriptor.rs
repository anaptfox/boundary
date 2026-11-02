use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::{
    ContractDigest, InteractionContract, InteractionId, ProgramDigest, ProgramError,
    ProgramErrorCode,
    canonical::{hash_json, normalize_value},
};
use crate::{
    codec::{DeclaredErrorCodec, WireCodec},
    interaction::{EffectClass, Interaction},
};

const PROGRAM_DOMAIN: &str = "boundary.program/v1";

/// Human-facing interaction documentation excluded from identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionDocumentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl InteractionDocumentation {
    /// Creates empty documentation.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            summary: None,
            description: None,
        }
    }

    /// Adds a short summary.
    #[must_use]
    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    /// Adds a longer description.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Returns the optional short summary.
    #[must_use]
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    /// Returns the optional longer description.
    #[must_use]
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

/// One contract plus its digest and non-identity authoring metadata.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionDescriptor {
    version: u8,
    contract: InteractionContract,
    contract_digest: ContractDigest,
    docs: InteractionDocumentation,
    annotations: Map<String, Value>,
}

impl InteractionDescriptor {
    /// Starts a descriptor builder and computes identity at [`InteractionDescriptorBuilder::finish`].
    #[must_use]
    pub fn builder(contract: InteractionContract) -> InteractionDescriptorBuilder {
        InteractionDescriptorBuilder {
            contract,
            docs: InteractionDocumentation::new(),
            annotations: Value::Object(Map::new()),
        }
    }

    /// Returns the portable interaction contract.
    #[must_use]
    pub const fn contract(&self) -> &InteractionContract {
        &self.contract
    }

    /// Returns the exact contract digest.
    #[must_use]
    pub const fn contract_digest(&self) -> &ContractDigest {
        &self.contract_digest
    }

    /// Returns non-identity documentation.
    #[must_use]
    pub const fn docs(&self) -> &InteractionDocumentation {
        &self.docs
    }

    /// Returns non-identity structured annotations.
    #[must_use]
    pub const fn annotations(&self) -> &Map<String, Value> {
        &self.annotations
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDescriptor {
    version: u8,
    contract: InteractionContract,
    contract_digest: ContractDigest,
    docs: InteractionDocumentation,
    annotations: Map<String, Value>,
}

impl<'de> Deserialize<'de> for InteractionDescriptor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawDescriptor::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom(
                "interaction descriptor version must be 1",
            ));
        }
        let expected = raw.contract.digest().map_err(serde::de::Error::custom)?;
        if expected != raw.contract_digest {
            return Err(serde::de::Error::custom(
                "interaction contract digest mismatch",
            ));
        }
        let annotations =
            normalize_value(Value::Object(raw.annotations)).map_err(serde::de::Error::custom)?;
        let Value::Object(annotations) = annotations else {
            return Err(serde::de::Error::custom("annotations must be an object"));
        };
        Ok(Self {
            version: 1,
            contract: raw.contract,
            contract_digest: expected,
            docs: raw.docs,
            annotations,
        })
    }
}

/// Builder for an [`InteractionDescriptor`].
#[derive(Debug)]
pub struct InteractionDescriptorBuilder {
    contract: InteractionContract,
    docs: InteractionDocumentation,
    annotations: Value,
}

impl InteractionDescriptorBuilder {
    /// Sets documentation that never affects contract or program identity.
    #[must_use]
    pub fn docs(mut self, docs: InteractionDocumentation) -> Self {
        self.docs = docs;
        self
    }

    /// Sets structured annotations that never affect identity.
    #[must_use]
    pub fn annotations(mut self, annotations: Value) -> Self {
        self.annotations = annotations;
        self
    }

    /// Validates metadata and constructs the descriptor.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] if annotations are not a portable JSON object
    /// or if contract identity cannot be computed.
    pub fn finish(self) -> Result<InteractionDescriptor, ProgramError> {
        let annotations = normalize_value(self.annotations)?;
        let Value::Object(annotations) = annotations else {
            return Err(ProgramError::new(
                ProgramErrorCode::InvalidMetadata,
                "descriptor.annotations",
                "annotations must be a JSON object",
            ));
        };
        let contract_digest = self.contract.digest()?;
        Ok(InteractionDescriptor {
            version: 1,
            contract: self.contract,
            contract_digest,
            docs: self.docs,
            annotations,
        })
    }
}

/// A deterministic, handler-free set of interaction descriptors.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    version: u8,
    interactions: Vec<InteractionDescriptor>,
    #[serde(rename = "programDigest")]
    digest: ProgramDigest,
}

impl Program {
    /// Starts an empty deterministic program builder.
    #[must_use]
    pub fn builder() -> ProgramBuilder {
        ProgramBuilder::default()
    }

    /// Parses and validates strict Program v1 JSON.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when JSON is non-portable, contains duplicate
    /// keys, violates Program v1, or carries a stale digest.
    pub fn from_json_str(source: &str) -> Result<Self, ProgramError> {
        let value = super::canonical::parse_strict_json(source)?;
        serde_json::from_value(value).map_err(|error| {
            ProgramError::new(
                ProgramErrorCode::DigestMismatch,
                "program",
                error.to_string(),
            )
        })
    }

    /// Returns interactions in UTF-8 identifier order.
    #[must_use]
    pub fn interactions(&self) -> &[InteractionDescriptor] {
        &self.interactions
    }

    /// Finds an interaction by exact identifier.
    #[must_use]
    pub fn interaction(&self, id: &InteractionId) -> Option<&InteractionDescriptor> {
        self.interactions
            .binary_search_by(|descriptor| descriptor.contract.id().cmp(id))
            .ok()
            .and_then(|index| self.interactions.get(index))
    }

    /// Finds an interaction from dynamic text, returning `None` for invalid ids.
    #[must_use]
    pub fn interaction_named(&self, id: &str) -> Option<&InteractionDescriptor> {
        InteractionId::parse(id)
            .ok()
            .and_then(|id| self.interaction(&id))
    }

    /// Returns the typed whole-program digest.
    #[must_use]
    pub const fn digest(&self) -> &ProgramDigest {
        &self.digest
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProgram {
    version: u8,
    interactions: Vec<InteractionDescriptor>,
    program_digest: ProgramDigest,
}

impl<'de> Deserialize<'de> for Program {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawProgram::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom("program version must be 1"));
        }
        let normalized = ProgramBuilder::from_descriptors(raw.interactions)
            .and_then(ProgramBuilder::finish)
            .map_err(serde::de::Error::custom)?;
        if normalized.digest != raw.program_digest {
            return Err(serde::de::Error::custom("program digest mismatch"));
        }
        Ok(normalized)
    }
}

/// Deterministic builder for a handler-free [`Program`].
#[derive(Debug, Default)]
pub struct ProgramBuilder {
    descriptors: BTreeMap<InteractionId, InteractionDescriptor>,
}

impl ProgramBuilder {
    /// Compiles and includes the handler-free contract declared by a native interaction.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when codecs cannot compile portable schemas,
    /// metadata is invalid, or the interaction id is already included.
    pub fn include<O>(self) -> Result<Self, ProgramError>
    where
        O: Interaction,
    {
        self.descriptor(descriptor_for::<O>()?)
    }

    /// Adds one already validated descriptor.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when the interaction id is already present.
    pub fn descriptor(mut self, descriptor: InteractionDescriptor) -> Result<Self, ProgramError> {
        let id = descriptor.contract.id().clone();
        if self.descriptors.insert(id.clone(), descriptor).is_some() {
            return Err(ProgramError::new(
                ProgramErrorCode::DuplicateInteraction,
                format!("program.interactions.{id}"),
                format!("duplicate interaction id `{id}`"),
            ));
        }
        Ok(self)
    }

    pub(crate) fn from_descriptors(
        descriptors: Vec<InteractionDescriptor>,
    ) -> Result<Self, ProgramError> {
        descriptors
            .into_iter()
            .try_fold(Self::default(), Self::descriptor)
    }

    /// Finalizes sorted interactions and computes whole-program identity.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] if canonical identity cannot be hashed.
    pub fn finish(self) -> Result<Program, ProgramError> {
        let interactions: Vec<_> = self.descriptors.into_values().collect();
        let identity = Value::Array(
            interactions
                .iter()
                .map(|descriptor| descriptor.contract.identity_value())
                .collect(),
        );
        let digest = ProgramDigest::from_hash(hash_json(PROGRAM_DOMAIN, &identity)?);
        Ok(Program {
            version: 1,
            interactions,
            digest,
        })
    }
}

pub(crate) fn descriptor_for<O>() -> Result<InteractionDescriptor, ProgramError>
where
    O: Interaction,
{
    let input = O::InputCodec::schema().map_err(|error| codec_error("inputSchema", error))?;
    let output = O::OutputCodec::schema().map_err(|error| codec_error("outputSchema", error))?;
    let error_schema =
        O::ErrorCodec::declared_schema().map_err(|error| codec_error("errorSchema", error))?;
    let footprint = O::Effect::parts(O::footprint());
    let mut contract = InteractionContract::builder(O::ID.as_str(), input, output)
        .reads(footprint.reads.iter().copied())
        .changes(footprint.changes.iter().copied());
    if let Some(error_schema) = error_schema {
        contract = contract.error_schema(error_schema);
    }
    let docs = O::docs();
    let mut documentation = InteractionDocumentation::new();
    if !docs.summary.is_empty() {
        documentation = documentation.with_summary(docs.summary);
    }
    if !docs.description.is_empty() {
        documentation = documentation.with_description(docs.description);
    }
    InteractionDescriptor::builder(contract.finish()?)
        .docs(documentation)
        .annotations(O::annotations())
        .finish()
}

fn codec_error(path: &str, error: impl std::fmt::Display) -> ProgramError {
    ProgramError::new(ProgramErrorCode::InvalidSchema, path, error.to_string())
}
