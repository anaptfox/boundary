use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::{
    ContractDigest, InteractionId, PortableSchema, ProgramError, ProgramErrorCode,
    canonical::hash_json,
    footprint::{valid_path, validate_footprint},
};

pub(crate) const CONTRACT_DOMAIN: &str = "boundary.interaction-contract/v1";

/// Handler-free portable meaning of one interaction.
///
/// The v1 contract digest includes the interaction id, input/output/error schemas,
/// `reads`, and `changes`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContract {
    version: u8,
    id: InteractionId,
    input_schema: PortableSchema,
    output_schema: PortableSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_schema: Option<PortableSchema>,
    reads: Vec<String>,
    changes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compensates: Option<InteractionId>,
    #[serde(skip)]
    digest: ContractDigest,
}

impl InteractionContract {
    /// Starts a validated contract builder.
    pub fn builder(
        id: impl AsRef<str>,
        input_schema: PortableSchema,
        output_schema: PortableSchema,
    ) -> InteractionContractBuilder {
        InteractionContractBuilder {
            id: InteractionId::parse(id),
            input_schema,
            output_schema,
            error_schema: None,
            reads: Vec::new(),
            changes: Vec::new(),
            idempotency_key: None,
            compensates: None,
        }
    }

    /// Parses a contract from strict JSON, rejecting duplicate keys.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when JSON is non-portable, contains duplicate
    /// keys, or violates the v1 contract and schema profile.
    pub fn from_json_str(source: &str) -> Result<Self, ProgramError> {
        let value = super::canonical::parse_strict_json(source)?;
        serde_json::from_value(value).map_err(|error| {
            ProgramError::new(
                ProgramErrorCode::InvalidFootprint,
                "contract",
                error.to_string(),
            )
        })
    }

    /// Returns the interaction identifier.
    #[must_use]
    pub const fn id(&self) -> &InteractionId {
        &self.id
    }

    /// Returns the input schema.
    #[must_use]
    pub const fn input_schema(&self) -> &PortableSchema {
        &self.input_schema
    }

    /// Returns the successful output schema.
    #[must_use]
    pub const fn output_schema(&self) -> &PortableSchema {
        &self.output_schema
    }

    /// Returns the declared portable error schema, when one exists.
    #[must_use]
    pub const fn error_schema(&self) -> Option<&PortableSchema> {
        self.error_schema.as_ref()
    }

    /// Returns the normalized read footprint.
    #[must_use]
    pub fn reads(&self) -> &[String] {
        &self.reads
    }

    /// Returns the normalized state-change footprint.
    #[must_use]
    pub fn changes(&self) -> &[String] {
        &self.changes
    }

    /// Returns the input path used as this interaction's idempotency key.
    #[must_use]
    pub fn idempotency_key(&self) -> Option<&str> {
        self.idempotency_key.as_deref()
    }

    /// Returns the interaction this contract declares it compensates.
    #[must_use]
    pub const fn compensates(&self) -> Option<&InteractionId> {
        self.compensates.as_ref()
    }

    /// Computes the contract's typed identity digest.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] if identity cannot be canonicalized and hashed.
    pub fn digest(&self) -> Result<ContractDigest, ProgramError> {
        Ok(self.digest.clone())
    }

    pub(crate) fn identity_value(&self) -> Value {
        let mut identity = Map::new();
        identity.insert("version".to_owned(), Value::from(1));
        identity.insert("id".to_owned(), Value::String(self.id.to_string()));
        identity.insert(
            "inputSchema".to_owned(),
            self.input_schema.as_value().clone(),
        );
        identity.insert(
            "outputSchema".to_owned(),
            self.output_schema.as_value().clone(),
        );
        if let Some(schema) = &self.error_schema {
            identity.insert("errorSchema".to_owned(), schema.as_value().clone());
        }
        identity.insert(
            "reads".to_owned(),
            Value::Array(self.reads.iter().cloned().map(Value::String).collect()),
        );
        identity.insert(
            "changes".to_owned(),
            Value::Array(self.changes.iter().cloned().map(Value::String).collect()),
        );
        if let Some(key) = &self.idempotency_key {
            identity.insert("idempotencyKey".to_owned(), Value::String(key.clone()));
        }
        if let Some(compensates) = &self.compensates {
            identity.insert(
                "compensates".to_owned(),
                Value::String(compensates.to_string()),
            );
        }
        Value::Object(identity)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawContract {
    version: u8,
    id: InteractionId,
    input_schema: PortableSchema,
    output_schema: PortableSchema,
    error_schema: Option<PortableSchema>,
    reads: Vec<String>,
    changes: Vec<String>,
    idempotency_key: Option<String>,
    compensates: Option<InteractionId>,
}

impl<'de> Deserialize<'de> for InteractionContract {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawContract::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom(
                "interaction contract version must be 1",
            ));
        }
        InteractionContractBuilder {
            id: Ok(raw.id),
            input_schema: raw.input_schema,
            output_schema: raw.output_schema,
            error_schema: raw.error_schema,
            reads: raw.reads,
            changes: raw.changes,
            idempotency_key: raw.idempotency_key,
            compensates: raw.compensates.map(Ok),
        }
        .finish()
        .map_err(serde::de::Error::custom)
    }
}

/// Builder that validates and normalizes one [`InteractionContract`].
#[derive(Debug)]
pub struct InteractionContractBuilder {
    id: Result<InteractionId, ProgramError>,
    input_schema: PortableSchema,
    output_schema: PortableSchema,
    error_schema: Option<PortableSchema>,
    reads: Vec<String>,
    changes: Vec<String>,
    idempotency_key: Option<String>,
    compensates: Option<Result<InteractionId, ProgramError>>,
}

impl InteractionContractBuilder {
    /// Declares a portable error result.
    #[must_use]
    pub fn error_schema(mut self, schema: PortableSchema) -> Self {
        self.error_schema = Some(schema);
        self
    }

    /// Declares resources observed by the interaction.
    #[must_use]
    pub fn reads<I, S>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.reads = values.into_iter().map(Into::into).collect();
        self
    }

    /// Declares resources mutated by the interaction.
    #[must_use]
    pub fn changes<I, S>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.changes = values.into_iter().map(Into::into).collect();
        self
    }

    /// Declares the input path that supplies an idempotency key.
    #[must_use]
    pub fn idempotency_key(mut self, path: impl Into<String>) -> Self {
        self.idempotency_key = Some(path.into());
        self
    }

    /// Declares the interaction compensated by this interaction.
    #[must_use]
    pub fn compensates(mut self, interaction_id: impl AsRef<str>) -> Self {
        self.compensates = Some(InteractionId::parse(interaction_id));
        self
    }

    /// Validates and constructs the contract.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] for an invalid id, trait, or footprint entry.
    pub fn finish(self) -> Result<InteractionContract, ProgramError> {
        if let Some(key) = &self.idempotency_key
            && !valid_path(key)
        {
            return Err(ProgramError::new(
                ProgramErrorCode::InvalidTrait,
                "contract.idempotencyKey",
                "idempotency key must be dot-separated [A-Za-z0-9_-] segments",
            ));
        }
        let id = self.id?;
        let compensates = self.compensates.map_or(Ok(None), |value| value.map(Some))?;
        if compensates.as_ref().is_some_and(|value| value == &id) {
            return Err(ProgramError::new(
                ProgramErrorCode::InvalidTrait,
                "contract.compensates",
                "an interaction cannot compensate itself",
            ));
        }
        let contract = InteractionContract {
            version: 1,
            id,
            input_schema: self.input_schema,
            output_schema: self.output_schema,
            error_schema: self.error_schema,
            reads: normalize_footprint(self.reads, "contract.reads")?,
            changes: normalize_footprint(self.changes, "contract.changes")?,
            idempotency_key: self.idempotency_key,
            compensates,
            digest: ContractDigest::from_hash([0; 32]),
        };
        let digest = hash_json(CONTRACT_DOMAIN, &contract.identity_value())
            .map(ContractDigest::from_hash)?;
        Ok(InteractionContract { digest, ..contract })
    }
}

fn normalize_footprint(values: Vec<String>, path: &str) -> Result<Vec<String>, ProgramError> {
    let mut unique = BTreeSet::new();
    for (index, value) in values.into_iter().enumerate() {
        validate_footprint(&value, &format!("{path}[{index}]"))?;
        unique.insert(value);
    }
    let mut normalized: Vec<_> = unique.into_iter().collect();
    normalized.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(normalized)
}
