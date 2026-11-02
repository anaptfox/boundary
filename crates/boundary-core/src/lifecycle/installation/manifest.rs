use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use super::super::{InstallationDigest, InstallationId, RealizationId, RequestControlDigest};
use crate::{InteractionId, PortableSchema, Program, ProgramDigest, ProgramError};

const INSTALLATION_DOMAIN: &str = "boundary.installation/v1";

/// Exact portable request realization advertised by an installation Catalog.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallationRequestAvailability {
    realization_id: RealizationId,
    control_digest: RequestControlDigest,
    preview_schema: PortableSchema,
}

impl InstallationRequestAvailability {
    /// Returns the host-issued request realization identity.
    #[must_use]
    pub const fn realization_id(&self) -> &RealizationId {
        &self.realization_id
    }

    /// Returns the exact Control contract identity.
    #[must_use]
    pub const fn control_digest(&self) -> &RequestControlDigest {
        &self.control_digest
    }

    /// Returns the public proposal schema pinned by this request realization.
    #[must_use]
    pub const fn preview_schema(&self) -> &PortableSchema {
        &self.preview_schema
    }
}

/// Realization-pinned direct and request availability for one interaction.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallationAvailability {
    direct: Option<RealizationId>,
    request: Option<InstallationRequestAvailability>,
}

impl InstallationAvailability {
    pub(in crate::lifecycle) const fn direct_only(direct: Option<RealizationId>) -> Self {
        Self {
            direct,
            request: None,
        }
    }

    pub(in crate::lifecycle) fn controlled(
        direct: Option<RealizationId>,
        realization_id: RealizationId,
        control_digest: RequestControlDigest,
        preview_schema: PortableSchema,
    ) -> Self {
        Self {
            direct,
            request: Some(InstallationRequestAvailability {
                realization_id,
                control_digest,
                preview_schema,
            }),
        }
    }

    /// Returns the exact direct realization identity, when advertised.
    #[must_use]
    pub const fn direct(&self) -> Option<&RealizationId> {
        self.direct.as_ref()
    }

    /// Returns the exact request realization and Control identity, when advertised.
    #[must_use]
    pub const fn request(&self) -> Option<&InstallationRequestAvailability> {
        self.request.as_ref()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalogDirect {
    realization_id: RealizationId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalogRequest {
    realization_id: RealizationId,
    control_digest: RequestControlDigest,
    preview_schema: PortableSchema,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalogEntry {
    interaction_id: InteractionId,
    #[serde(default)]
    direct: Option<RawCatalogDirect>,
    #[serde(default)]
    request: Option<RawCatalogRequest>,
}

/// Exhaustive portable availability for one installation Program.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallationCatalog {
    version: u8,
    program_digest: ProgramDigest,
    interactions: BTreeMap<InteractionId, InstallationAvailability>,
}

impl InstallationCatalog {
    pub(in crate::lifecycle) fn new(
        program: &Program,
        interactions: BTreeMap<InteractionId, InstallationAvailability>,
    ) -> Result<Self, String> {
        let catalog = Self {
            version: 1,
            program_digest: program.digest().clone(),
            interactions,
        };
        catalog.validate_for(program)?;
        Ok(catalog)
    }

    /// Returns the Program identity covered by this catalog.
    #[must_use]
    pub const fn program_digest(&self) -> &ProgramDigest {
        &self.program_digest
    }

    /// Returns exhaustive availability keyed by interaction id.
    #[must_use]
    pub const fn interactions(&self) -> &BTreeMap<InteractionId, InstallationAvailability> {
        &self.interactions
    }

    /// Finds availability for one declared interaction.
    #[must_use]
    pub fn interaction(&self, id: &InteractionId) -> Option<&InstallationAvailability> {
        self.interactions.get(id)
    }

    pub(in crate::lifecycle) fn validate_for(&self, program: &Program) -> Result<(), String> {
        if self.version != 1 {
            return Err("catalog version must be 1".to_owned());
        }
        if &self.program_digest != program.digest() {
            return Err("catalog Program digest mismatch".to_owned());
        }
        if self.interactions.len() != program.interactions().len()
            || program
                .interactions()
                .iter()
                .any(|descriptor| !self.interactions.contains_key(descriptor.contract().id()))
        {
            return Err("catalog availability must cover the Program exactly".to_owned());
        }
        validate_unique_realizations(&self.interactions)?;
        Ok(())
    }

    pub(in crate::lifecycle) fn value(&self) -> Value {
        let mut interactions = Vec::new();
        for (id, availability) in &self.interactions {
            let mut entry = Map::new();
            entry.insert(
                "interactionId".to_owned(),
                Value::String(id.as_str().to_owned()),
            );
            if let Some(realization_id) = &availability.direct {
                entry.insert("direct".to_owned(), realization_value(realization_id));
            }
            if let Some(request) = &availability.request {
                let mut request_value = Map::new();
                request_value.insert(
                    "realizationId".to_owned(),
                    Value::String(request.realization_id.as_str().to_owned()),
                );
                request_value.insert(
                    "controlDigest".to_owned(),
                    Value::String(request.control_digest.as_str().to_owned()),
                );
                request_value.insert(
                    "previewSchema".to_owned(),
                    request.preview_schema.as_value().clone(),
                );
                entry.insert("request".to_owned(), Value::Object(request_value));
            }
            interactions.push(Value::Object(entry));
        }
        let mut catalog = Map::new();
        catalog.insert("version".to_owned(), Value::from(1));
        catalog.insert(
            "programDigest".to_owned(),
            Value::String(self.program_digest.as_str().to_owned()),
        );
        catalog.insert("interactions".to_owned(), Value::Array(interactions));
        Value::Object(catalog)
    }
}

impl Serialize for InstallationCatalog {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.value().serialize(serializer)
    }
}

fn realization_value(realization_id: &RealizationId) -> Value {
    let mut value = Map::new();
    value.insert(
        "realizationId".to_owned(),
        Value::String(realization_id.as_str().to_owned()),
    );
    Value::Object(value)
}

fn validate_unique_realizations(
    interactions: &BTreeMap<InteractionId, InstallationAvailability>,
) -> Result<(), String> {
    let mut realizations = BTreeSet::new();
    for availability in interactions.values() {
        for realization_id in [
            availability.direct.as_ref(),
            availability
                .request
                .as_ref()
                .map(|request| &request.realization_id),
        ]
        .into_iter()
        .flatten()
        {
            if !realizations.insert(realization_id) {
                return Err("catalog realization ids must be globally unique".to_owned());
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawInstallationCatalog {
    version: u8,
    program_digest: ProgramDigest,
    interactions: Vec<RawCatalogEntry>,
}

impl<'de> Deserialize<'de> for InstallationCatalog {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawInstallationCatalog::deserialize(deserializer)?;
        if raw.version != 1 {
            return Err(serde::de::Error::custom("catalog version must be 1"));
        }
        let mut interactions = BTreeMap::new();
        for entry in raw.interactions {
            let availability = InstallationAvailability {
                direct: entry.direct.map(|direct| direct.realization_id),
                request: entry
                    .request
                    .map(|request| InstallationRequestAvailability {
                        realization_id: request.realization_id,
                        control_digest: request.control_digest,
                        preview_schema: request.preview_schema,
                    }),
            };
            if interactions
                .insert(entry.interaction_id, availability)
                .is_some()
            {
                return Err(serde::de::Error::custom(
                    "catalog contains a duplicate interaction id",
                ));
            }
        }
        validate_unique_realizations(&interactions).map_err(serde::de::Error::custom)?;
        Ok(Self {
            version: raw.version,
            program_digest: raw.program_digest,
            interactions,
        })
    }
}

/// Data-only, digest-bearing description of one immutable installation.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationManifest {
    version: u8,
    installation_id: InstallationId,
    program: Program,
    catalog: InstallationCatalog,
    installation_digest: InstallationDigest,
}

impl InstallationManifest {
    pub(super) fn new(
        installation_id: InstallationId,
        program: Program,
        catalog: InstallationCatalog,
    ) -> Result<Self, ProgramError> {
        let installation_digest = installation_digest(&program, &catalog)?;
        Ok(Self {
            version: 1,
            installation_id,
            program,
            catalog,
            installation_digest,
        })
    }

    /// Returns the host-issued installation identity.
    #[must_use]
    pub const fn installation_id(&self) -> &InstallationId {
        &self.installation_id
    }

    /// Returns the exact handler-free Program installed here.
    #[must_use]
    pub const fn program(&self) -> &Program {
        &self.program
    }

    /// Returns exhaustive portable availability for the Program.
    #[must_use]
    pub const fn catalog(&self) -> &InstallationCatalog {
        &self.catalog
    }

    /// Returns installation identity independent of its host-issued id.
    #[must_use]
    pub const fn installation_digest(&self) -> &InstallationDigest {
        &self.installation_digest
    }

    fn validate(self) -> Result<Self, String> {
        if self.version != 1 {
            return Err("installation version must be 1".to_owned());
        }
        self.catalog.validate_for(&self.program)?;
        let expected =
            installation_digest(&self.program, &self.catalog).map_err(|error| error.to_string())?;
        if expected != self.installation_digest {
            return Err("installation digest mismatch".to_owned());
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawInstallationManifest {
    version: u8,
    installation_id: InstallationId,
    program: Program,
    catalog: InstallationCatalog,
    installation_digest: InstallationDigest,
}

impl<'de> Deserialize<'de> for InstallationManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawInstallationManifest::deserialize(deserializer)?;
        Self {
            version: raw.version,
            installation_id: raw.installation_id,
            program: raw.program,
            catalog: raw.catalog,
            installation_digest: raw.installation_digest,
        }
        .validate()
        .map_err(serde::de::Error::custom)
    }
}

fn installation_digest(
    program: &Program,
    catalog: &InstallationCatalog,
) -> Result<InstallationDigest, ProgramError> {
    let mut identity = Map::new();
    identity.insert("version".to_owned(), Value::from(1));
    identity.insert(
        "program".to_owned(),
        super::super::artifact::program_value(program),
    );
    identity.insert("catalog".to_owned(), catalog.value());
    super::super::artifact::hash_artifact(INSTALLATION_DOMAIN, &Value::Object(identity))
        .map(InstallationDigest::from_hash)
}
