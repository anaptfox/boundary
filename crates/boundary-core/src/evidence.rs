//! Explicit host-issued causal evidence, independent of invocation observation v1.
//! References describe observations; they never grant authority or prescribe retry.

use std::{collections::BTreeMap, future::Future};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::{canonical_json, lifecycle::InvocationObservation};

/// Stable validation failures shared with the portable TypeScript envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionEvidenceErrorCode {
    /// Invalid fields, identities, version, observation or subject state.
    InvalidExecutionEvidence,
    /// Conflicting entity kinds, self-reference, or both parent and child.
    ConflictingEvidenceReference,
    /// The same reference appears twice in one causal link collection.
    DuplicateEvidenceReference,
}

impl ExecutionEvidenceErrorCode {
    /// Returns the stable portable diagnostic code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidExecutionEvidence => "INVALID_EXECUTION_EVIDENCE",
            Self::ConflictingEvidenceReference => "CONFLICTING_EVIDENCE_REFERENCE",
            Self::DuplicateEvidenceReference => "DUPLICATE_EVIDENCE_REFERENCE",
        }
    }
}

/// An invalid envelope is rejected before host publication.
#[derive(Clone, Debug, Error)]
#[error("{code:?} at {path}: {message}")]
pub struct ExecutionEvidenceError {
    /// Stable diagnostic category.
    pub code: ExecutionEvidenceErrorCode,
    /// Location within the supplied envelope.
    pub path: String,
    /// Language-local diagnostic explanation.
    pub message: String,
}

fn error(path: &str, message: &str) -> ExecutionEvidenceError {
    ExecutionEvidenceError {
        code: ExecutionEvidenceErrorCode::InvalidExecutionEvidence,
        path: path.to_owned(),
        message: message.to_owned(),
    }
}

fn object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
    path: &str,
) -> Result<&'a Map<String, Value>, ExecutionEvidenceError> {
    let record = value
        .as_object()
        .ok_or_else(|| error(path, "expected an evidence object"))?;
    if required.iter().any(|key| !record.contains_key(*key)) {
        return Err(error(path, "required evidence fields are missing"));
    }
    if let Some(extra) = record
        .keys()
        .find(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(error(&format!("{path}.{extra}"), "unknown evidence field"));
    }
    Ok(record)
}

fn identifier(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~:/-".contains(&byte))
}

#[derive(Clone, Copy)]
struct Reference<'a> {
    kind: &'a str,
    namespace: &'a str,
    id: &'a str,
}

impl<'a> Reference<'a> {
    const fn key(self) -> (&'a str, &'a str) {
        (self.namespace, self.id)
    }
}

fn reference<'a>(
    value: &'a Value,
    kinds: &[&str],
    path: &str,
) -> Result<Reference<'a>, ExecutionEvidenceError> {
    object(value, &["kind", "namespace", "id"], &[], path)?;
    let kind = value["kind"]
        .as_str()
        .filter(|kind| kinds.contains(kind))
        .ok_or_else(|| {
            error(
                &format!("{path}.kind"),
                "reference has the wrong entity kind",
            )
        })?;
    let text = |field| {
        value[field]
            .as_str()
            .filter(|text| identifier(text))
            .ok_or_else(|| {
                error(
                    &format!("{path}.{field}"),
                    "reference identity must be 1-256 bounded ASCII identifier characters",
                )
            })
    };
    Ok(Reference {
        kind,
        namespace: text("namespace")?,
        id: text("id")?,
    })
}

fn remember<'a>(
    identities: &mut BTreeMap<(&'a str, &'a str), &'a str>,
    reference: Reference<'a>,
    path: &str,
) -> Result<(), ExecutionEvidenceError> {
    if identities
        .get(&reference.key())
        .is_some_and(|kind| *kind != reference.kind)
    {
        return Err(ExecutionEvidenceError {
            code: ExecutionEvidenceErrorCode::ConflictingEvidenceReference,
            path: path.to_owned(),
            message: "one namespace and ID cannot identify different entity kinds".to_owned(),
        });
    }
    identities.insert(reference.key(), reference.kind);
    Ok(())
}

/// Immutable validated execution evidence. Deserialization validates the envelope.
/// The completed invocation and any uncertain subject remain separate facts.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct ExecutionEvidence(Value);

impl ExecutionEvidence {
    /// Validates explicit causal data without authenticating its publisher.
    ///
    /// # Errors
    /// Rejects malformed fields and references, duplicates, or conflicting links.
    pub fn from_value(value: Value) -> Result<Self, ExecutionEvidenceError> {
        canonical_json(&value).map_err(|cause| error("evidence", &cause.to_string()))?;
        object(
            &value,
            &["version", "reference", "invocation"],
            &["subject", "parents", "children", "attempt", "receipt"],
            "evidence",
        )?;
        if value["version"].as_f64() != Some(1.0) {
            return Err(error(
                "evidence.version",
                "unsupported execution evidence version",
            ));
        }
        let own = reference(&value["reference"], &["evidence"], "evidence.reference")?;
        object(
            &value["invocation"],
            &["reference", "observation"],
            &[],
            "evidence.invocation",
        )?;
        let invoked = reference(
            &value["invocation"]["reference"],
            &["invocation"],
            "evidence.invocation.reference",
        )?;
        InvocationObservation::from_value(value["invocation"]["observation"].clone())
            .map_err(|cause| error("evidence.invocation.observation", &cause.to_string()))?;
        let mut identities = BTreeMap::new();
        remember(&mut identities, own, "evidence.reference")?;
        remember(&mut identities, invoked, "evidence.invocation.reference")?;
        if let Some(subject) = value.get("subject") {
            object(subject, &["reference", "state"], &[], "evidence.subject")?;
            remember(
                &mut identities,
                reference(
                    &subject["reference"],
                    &["subject"],
                    "evidence.subject.reference",
                )?,
                "evidence.subject.reference",
            )?;
            if !subject["state"].as_str().is_some_and(|state| {
                [
                    "pending",
                    "completed",
                    "not-started",
                    "not-completed",
                    "uncertain",
                ]
                .contains(&state)
            }) {
                return Err(error("evidence.subject.state", "unsupported subject state"));
            }
        }
        for field in ["attempt", "receipt"] {
            if let Some(value) = value.get(field) {
                remember(
                    &mut identities,
                    reference(value, &[field], &format!("evidence.{field}"))?,
                    &format!("evidence.{field}"),
                )?;
            }
        }
        let mut linked = BTreeMap::new();
        for field in ["parents", "children"] {
            let Some(raw) = value.get(field) else {
                continue;
            };
            let links = raw
                .as_array()
                .filter(|links| links.len() <= 128)
                .ok_or_else(|| {
                    error(
                        &format!("evidence.{field}"),
                        "causal links must be an array with at most 128 references",
                    )
                })?;
            for (index, raw) in links.iter().enumerate() {
                let path = format!("evidence.{field}[{index}]");
                let reference = reference(
                    raw,
                    &["evidence", "invocation", "subject", "attempt", "receipt"],
                    &path,
                )?;
                remember(&mut identities, reference, &path)?;
                if reference.key() == own.key() || reference.key() == invoked.key() {
                    return Err(ExecutionEvidenceError {
                        code: ExecutionEvidenceErrorCode::ConflictingEvidenceReference,
                        path,
                        message: "evidence and its invocation cannot be their own causal links"
                            .to_owned(),
                    });
                }
                if let Some(previous) = linked.insert(reference.key(), field) {
                    return Err(ExecutionEvidenceError { code: if previous == field { ExecutionEvidenceErrorCode::DuplicateEvidenceReference } else { ExecutionEvidenceErrorCode::ConflictingEvidenceReference }, path, message: "causal references must be unique and cannot be both parents and children".to_owned() });
                }
            }
        }
        Ok(Self(value))
    }

    /// Reads immutable public evidence. No input, output or private scope is added.
    #[must_use]
    pub const fn as_value(&self) -> &Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ExecutionEvidence {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_value(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Delivery evidence is distinct from invocation and subject truth.
#[derive(Debug)]
pub enum ExecutionEvidencePublication<DeliveryError> {
    /// The host publisher returned successfully; consumer observation is not proved.
    Published {
        /// The unchanged, validated host evidence.
        evidence: ExecutionEvidence,
    },
    /// The host publisher failed; the original execution evidence is retained.
    DeliveryFailed {
        /// The unchanged, validated host evidence.
        evidence: ExecutionEvidence,
        /// A private delivery error returned to the publishing host.
        cause: DeliveryError,
    },
}

/// Explicit host publication. It executes no interaction and retries nothing.
pub async fn publish_execution_evidence<Publish, Published, DeliveryError>(
    evidence: ExecutionEvidence,
    publish: Publish,
) -> ExecutionEvidencePublication<DeliveryError>
where
    Publish: FnOnce(ExecutionEvidence) -> Published,
    Published: Future<Output = Result<(), DeliveryError>>,
{
    match publish(evidence.clone()).await {
        Ok(()) => ExecutionEvidencePublication::Published { evidence },
        Err(cause) => ExecutionEvidencePublication::DeliveryFailed { evidence, cause },
    }
}
