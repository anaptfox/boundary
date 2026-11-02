//! Turning a reachable surface into tools a model can see.
//!
//! Tools are derived from Binding manifests, so what a model can reach is
//! exactly what some application published and nothing more. Two rules shape
//! this file.
//!
//! **The Projection is the only narrowing.** Every interaction on a published
//! Binding becomes a tool; there is no second, softer list that hides one. An
//! application that wants a model to see less publishes a smaller Projection.
//! A tool being present is still not a grant: the application admits every
//! call it receives.
//!
//! **This layer judges nothing.** Manifests arrive here as JSON so the crate
//! stays independent of the core types, and pins are copied through verbatim.
//! Validating a manifest is the caller's job and happens before this point:
//! the `boundary` binary deserializes through `BindingManifest`, which validates.
//! Whatever survives that, this layer reports without deciding a pin is
//! acceptable, because the receiving host checks every one of them again.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// One interaction exposed to a model.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// The tool name a model calls.
    pub name: String,
    /// What it does, when the surface said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The interaction's input schema, verbatim from the manifest.
    pub input_schema: Value,
    /// Hints for a model. `readOnlyHint` is true when the interaction declares
    /// no changes.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub annotations: Map<String, Value>,
}

/// The pins needed to invoke one tool, copied from a manifest.
///
/// Every field is passed through to the receiving host, which validates them.
/// Nothing here is trusted or interpreted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolTarget {
    /// Which reachable surface owns this tool.
    pub binding_digest: String,
    /// The live Installation identity.
    pub installation_id: String,
    /// The interaction being invoked.
    pub interaction_id: String,
    /// Expected contract pin.
    pub expected_contract_digest: String,
    /// Actual contract pin.
    pub actual_contract_digest: String,
    /// Direct or request.
    pub mode: String,
    /// The realization pin.
    pub realization_id: String,
    /// Whether the interaction takes an input at all.
    pub input_arity: u8,
}

/// A tool and how to reach it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolEntry {
    /// What the model sees.
    pub tool: Tool,
    /// What the invoker needs.
    pub target: ToolTarget,
}

/// Why a manifest could not be turned into tools.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ToolError {
    /// A manifest field was missing or the wrong type.
    #[error("manifest is malformed at {path}")]
    Malformed {
        /// Where the problem was.
        path: String,
    },
    /// An alias cannot be used as a tool name.
    ///
    /// Aliases come verbatim from a remote manifest, so they are chosen by
    /// whoever serves it. Homoglyphs, control characters, and whitespace
    /// tricks in a name a model reads are a name-confusion channel, and a
    /// name is not the place to be liberal.
    #[error("tool name {alias:?} at {path} is not a usable name: {reason}")]
    UnusableName {
        /// The offending alias.
        alias: String,
        /// Where it appeared.
        path: String,
        /// Why it cannot be used.
        reason: String,
    },
}

/// Longest tool name accepted. Generous for a real alias; short enough that a
/// name cannot be used to flood what a model reads.
const MAX_ALIAS: usize = 64;

/// Checks an alias is a plain, unambiguous name.
///
/// ASCII letters, digits, `_`, `-`, and `.` only. Everything a remote
/// manifest could otherwise smuggle into a tool list — a right-to-left
/// override, a zero-width joiner, a Cyrillic `а` that looks like `a`, a
/// newline — is refused by construction rather than by a denylist that has to
/// keep up with new tricks.
fn usable_alias(alias: &str, path: &str) -> Result<(), ToolError> {
    let refuse = |reason: String| ToolError::UnusableName {
        alias: alias.to_owned(),
        path: path.to_owned(),
        reason,
    };
    if alias.is_empty() {
        return Err(refuse("it is empty".to_owned()));
    }
    if alias.len() > MAX_ALIAS {
        return Err(refuse(format!(
            "it is {} bytes, over the {MAX_ALIAS}-byte limit",
            alias.len()
        )));
    }
    if let Some(character) = alias
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
    {
        return Err(refuse(format!(
            "it contains {character:?}; a tool name is ASCII letters, digits, and {:?}",
            "_-."
        )));
    }
    Ok(())
}

fn text(value: &Value, key: &str, path: &str) -> Result<String, ToolError> {
    value[key]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolError::Malformed {
            path: format!("{path}.{key}"),
        })
}

/// Reads the input schema and documentation for one interaction id out of the
/// manifest's expected Program.
///
/// The expected Program is the caller-facing contract set, which is the one a
/// model should see: it is what the surface promised, not what some
/// implementation happens to accept.
fn contract_for<'a>(manifest: &'a Value, interaction_id: &str) -> Option<&'a Value> {
    manifest["expectedProgram"]["interactions"]
        .as_array()?
        .iter()
        .find(|descriptor| descriptor["contract"]["id"].as_str() == Some(interaction_id))
}

/// Derives tools from one untrusted manifest: one per bound interaction.
///
/// There is no filter parameter on purpose. An application keeps a
/// delete-shaped interaction out of a model's reach by not projecting it, which
/// also keeps it out of the Binding — the only narrowing that is enforced.
///
/// # Errors
///
/// Returns [`ToolError::Malformed`] when the manifest lacks a field this needs.
pub fn tools_from_manifest(manifest: &Value) -> Result<Vec<ToolEntry>, ToolError> {
    let binding_digest = text(manifest, "bindingDigest", "manifest")?;
    let installation_id = text(manifest, "installationId", "manifest")?;
    let interactions = manifest["interactions"]
        .as_array()
        .ok_or_else(|| ToolError::Malformed {
            path: "manifest.interactions".to_owned(),
        })?;

    let mut entries = Vec::new();
    for (index, interaction) in interactions.iter().enumerate() {
        let path = format!("manifest.interactions[{index}]");
        let interaction_id = text(interaction, "interactionId", &path)?;

        let descriptor = contract_for(manifest, &interaction_id);
        let input_schema = descriptor
            .map(|descriptor| descriptor["contract"]["inputSchema"].clone())
            .filter(|schema| !schema.is_null())
            // An interaction with no input still needs a schema a model can
            // satisfy: an object that accepts nothing.
            .unwrap_or_else(
                || json!({"type": "object", "properties": {}, "additionalProperties": false}),
            );

        // Description text is written by whoever serves the manifest and is
        // read by a model as tool documentation. Naming the surface it came
        // from is the difference between "a tool says this" and "Boundary says
        // this": a hostile surface can still write whatever it likes, but it
        // cannot write it under someone else's name, or under none.
        let written = descriptor.and_then(|descriptor| {
            descriptor["docs"]["description"]
                .as_str()
                .or_else(|| descriptor["docs"]["summary"].as_str())
                .map(ToOwned::to_owned)
        });
        let description = Some(match written {
            Some(text) => format!("[from binding {binding_digest}] {text}"),
            None => format!("[from binding {binding_digest}]"),
        });

        let changes_empty = descriptor
            .and_then(|descriptor| descriptor["contract"]["changes"].as_array())
            .is_none_or(Vec::is_empty);
        let mut annotations = Map::new();
        annotations.insert("readOnlyHint".to_owned(), Value::Bool(changes_empty));

        let arity = interaction["inputArity"].as_u64().unwrap_or(1);

        entries.push(ToolEntry {
            tool: Tool {
                // The alias is the caller-facing name this surface chose, so it
                // is what a model should see.
                name: {
                    let alias = text(interaction, "alias", &path)?;
                    usable_alias(&alias, &path)?;
                    alias
                },
                description,
                input_schema,
                annotations,
            },
            target: ToolTarget {
                binding_digest: binding_digest.clone(),
                installation_id: installation_id.clone(),
                interaction_id,
                expected_contract_digest: text(interaction, "expectedContractDigest", &path)?,
                actual_contract_digest: text(interaction, "actualContractDigest", &path)?,
                mode: text(interaction, "mode", &path)?,
                realization_id: text(interaction, "realizationId", &path)?,
                input_arity: u8::try_from(arity).unwrap_or(1),
            },
        });
    }
    Ok(entries)
}

/// What merging produced: the catalog, and every name it could not serve.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MergedTools {
    /// Tools a model can call, sorted by name.
    pub entries: Vec<ToolEntry>,
    /// Names claimed by more than one surface, sorted. Every one was dropped.
    pub dropped: Vec<DuplicateName>,
}

/// One name two or more surfaces claimed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DuplicateName {
    /// The clashing name.
    pub name: String,
    /// Every binding digest offering it, sorted.
    pub bindings: Vec<String>,
}

/// Merges tools from every reachable surface into one catalog.
///
/// Names must be unique across surfaces. A clash is never resolved by
/// prefixing or by picking a winner: inventing a disambiguation would hide
/// which surface a model actually reached. The clashing pair is **dropped**
/// and reported.
///
/// Dropping rather than failing is the point. Two honest applications
/// choosing one alias is a decision for a person, and the person still needs
/// their other tools while they make it. Failing the whole catalog would also
/// hand any surface a free denial of service: one registration claiming an
/// existing alias would deny the user every tool from every application. That
/// is the same principle already applied to an unreachable surface — one
/// application must not be able to deny the rest.
#[must_use]
pub fn merge(catalogs: Vec<Vec<ToolEntry>>) -> MergedTools {
    let mut merged: Vec<ToolEntry> = catalogs.into_iter().flatten().collect();
    merged.sort_by(|left, right| left.tool.name.cmp(&right.tool.name));

    let mut entries: Vec<ToolEntry> = Vec::with_capacity(merged.len());
    let mut dropped: Vec<DuplicateName> = Vec::new();
    let mut index = 0;
    while index < merged.len() {
        let name = merged[index].tool.name.clone();
        let mut end = index + 1;
        while end < merged.len() && merged[end].tool.name == name {
            end += 1;
        }
        if end - index == 1 {
            entries.push(merged[index].clone());
        } else {
            let mut bindings: Vec<String> = merged[index..end]
                .iter()
                .map(|entry| entry.target.binding_digest.clone())
                .collect();
            bindings.sort();
            bindings.dedup();
            dropped.push(DuplicateName { name, bindings });
        }
        index = end;
    }
    MergedTools { entries, dropped }
}
