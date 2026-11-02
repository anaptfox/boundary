//! `boundary call`: resolves an interaction across reachable bindings and invokes it.
//!
//! Resolution asks the bus for every reachable Reach record, fetches each
//! record's manifest, and looks for the one binding that exposes the
//! requested interaction id. Every field of the invocation is pinned from that
//! fetched manifest; nothing here invents a digest, id, mode, or realization.
//!
//! A fault or a denial is not a command-line crash: the outcome envelope is
//! printed like any other outcome, and the process exits non-zero. Nothing
//! here retries, because retry safety follows the outcome's certainty, a
//! judgment this command must not make on the caller's behalf.

use std::path::PathBuf;
use std::process::ExitCode;

use boundary_core::InteractionId;
use boundary_core::handoff::{HandoffInvocation, HandoffResult};
use boundary_core::lifecycle::{BindingDigest, BindingManifest, BoundInteraction, InteractionMode};
use boundary_reach::{ReachRecord, Transport, invoke};
use serde_json::Value;

use crate::discovery::{inspect_record, reachable_records};
use crate::{describe, socket_from_env_or_default};

/// Runs `boundary call <interactionId> [--input JSON] [--socket PATH]`.
pub(crate) fn run(arguments: &[String]) -> Result<ExitCode, String> {
    let Some(parsed) = parse_arguments(arguments)? else {
        println!("{CALL_USAGE}");
        return Ok(ExitCode::SUCCESS);
    };
    let interaction_id = InteractionId::parse(&parsed.interaction_id).map_err(|error| {
        format!(
            "{:?} is not a valid interaction id: {error}",
            parsed.interaction_id
        )
    })?;
    let input = match &parsed.input {
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|error| format!("--input is not valid JSON: {error}"))?,
        None => Value::Object(serde_json::Map::new()),
    };
    let socket = match parsed.socket {
        Some(path) => path,
        None => socket_from_env_or_default()?,
    };

    let records = reachable_records(&socket)?;
    if records.is_empty() {
        return Err("no reachable bindings. A host registers when it installs.".to_owned());
    }

    let (transport, manifest, mode) = resolve_interaction(
        &records,
        &interaction_id,
        &parsed.interaction_id,
        parsed.mode,
        parsed.binding.as_ref(),
    )?;

    let invocation =
        HandoffInvocation::new(&manifest, &interaction_id, mode, input).map_err(|error| {
            format!("could not pin the invocation from the fetched manifest: {error}")
        })?;

    let outcome = invoke(&transport, &invocation)
        .map_err(|error| format!("{}: {error}", describe(&transport)))?;

    let printed = serde_json::to_string_pretty(&outcome)
        .map_err(|error| format!("could not encode the outcome: {error}"))?;
    println!("{printed}");

    // A fault or a denial is a legitimate outcome, not a crash: it is printed
    // like any other and only the exit code reports that the call did not
    // succeed. This command never decides whether it is safe to retry.
    let succeeded = matches!(
        outcome.result(),
        HandoffResult::Returned { .. } | HandoffResult::Proposed { .. }
    );
    Ok(if succeeded {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

struct ParsedArguments {
    interaction_id: String,
    input: Option<String>,
    socket: Option<PathBuf>,
    mode: Option<InteractionMode>,
    binding: Option<BindingDigest>,
}

const CALL_USAGE: &str = "usage: boundary call <interactionId> [--input JSON] [--mode direct|request] [--binding DIGEST] [--socket PATH]";

fn parse_arguments(arguments: &[String]) -> Result<Option<ParsedArguments>, String> {
    let mut interaction_id = None;
    let mut input = None;
    let mut socket = None;
    let mut mode = None;
    let mut binding = None;
    let mut help = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--help" | "-h" => {
                help = true;
                index += 1;
            }
            "--binding" => {
                if binding.is_some() {
                    return Err("--binding may only be supplied once".to_owned());
                }
                let value = arguments
                    .get(index + 1)
                    .filter(|value| !value.starts_with('-'))
                    .ok_or_else(|| "--binding needs a digest".to_owned())?;
                binding = Some(
                    BindingDigest::parse(value)
                        .map_err(|error| format!("--binding is invalid: {error}"))?,
                );
                index += 2;
            }
            "--input" => {
                if input.is_some() {
                    return Err("--input may only be supplied once".to_owned());
                }
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| "--input needs a JSON value".to_owned())?;
                input = Some(value.clone());
                index += 2;
            }
            "--socket" => {
                if socket.is_some() {
                    return Err("--socket may only be supplied once".to_owned());
                }
                let value = arguments
                    .get(index + 1)
                    .filter(|value| !value.trim().is_empty() && !value.starts_with('-'))
                    .ok_or_else(|| "--socket needs a path".to_owned())?;
                socket = Some(PathBuf::from(value));
                index += 2;
            }
            "--mode" => {
                if mode.is_some() {
                    return Err("--mode may only be supplied once".to_owned());
                }
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| "--mode needs `direct` or `request`".to_owned())?;
                mode = Some(match value.as_str() {
                    "direct" => InteractionMode::Direct,
                    "request" => InteractionMode::Request,
                    other => {
                        return Err(format!(
                            "--mode must be `direct` or `request`, got {other:?}"
                        ));
                    }
                });
                index += 2;
            }
            other if interaction_id.is_none() && !other.starts_with("--") => {
                interaction_id = Some(other.to_owned());
                index += 1;
            }
            other => {
                return Err(format!(
                    "unrecognized argument {other:?} for `boundary call`"
                ));
            }
        }
    }
    if help {
        return Ok(None);
    }
    let interaction_id = interaction_id.ok_or_else(|| CALL_USAGE.to_owned())?;
    Ok(Some(ParsedArguments {
        interaction_id,
        input,
        socket,
        mode,
        binding,
    }))
}

/// Resolves an interaction id to exactly one reachable binding: its transport,
/// its fetched manifest, and the mode to invoke.
///
/// A record that exposes no matching interaction is silently skipped. Two or
/// more that do is reported as an ambiguity rather than resolved by picking
/// one, so the caller decides which binding they meant.
fn resolve_interaction(
    records: &[ReachRecord],
    interaction_id: &InteractionId,
    interaction_id_raw: &str,
    requested_mode: Option<InteractionMode>,
    requested_binding: Option<&BindingDigest>,
) -> Result<(Transport, BindingManifest, InteractionMode), String> {
    let mut matches: Vec<(Transport, BindingManifest, InteractionMode)> = Vec::new();
    let mut fetch_failures: Vec<String> = Vec::new();

    if let Some(binding) = requested_binding
        && !records
            .iter()
            .any(|record| record.binding_digest() == binding.as_str())
    {
        return Err(format!(
            "requested Binding {binding} is not registered on this bus"
        ));
    }
    for record in records {
        if requested_binding.is_some_and(|binding| record.binding_digest() != binding.as_str()) {
            continue;
        }
        match inspect_record(record) {
            Ok((transport, manifest)) => {
                if let Some(mode) = select_mode(&manifest, interaction_id, requested_mode) {
                    matches.push((transport, manifest, mode));
                }
            }
            Err(reason) => fetch_failures.push(format!("{}: {reason}", record.binding_digest())),
        }
    }

    if matches.is_empty() {
        let in_mode = match requested_mode {
            Some(InteractionMode::Direct) => " in direct mode",
            Some(InteractionMode::Request) => " in request mode",
            None => "",
        };
        let in_binding = requested_binding
            .map(|binding| format!(" in requested Binding {binding}"))
            .unwrap_or_default();
        return Err(if fetch_failures.is_empty() {
            format!(
                "no reachable binding exposes interaction {interaction_id_raw:?}{in_mode}{in_binding}"
            )
        } else {
            format!(
                "could not inspect interaction {interaction_id_raw:?}{in_mode}{in_binding}; manifest fetch failed for: {}",
                fetch_failures.join("; ")
            )
        });
    }

    if requested_binding.is_none() && !fetch_failures.is_empty() {
        return Err(format!(
            "cannot prove a unique Binding for interaction {interaction_id_raw:?}; manifest inspection failed for: {}. Select an inspected Binding with --binding DIGEST",
            fetch_failures.join("; ")
        ));
    }

    if matches.len() > 1 {
        let digests: Vec<String> = matches
            .iter()
            .map(|(_, manifest, _)| manifest.binding_digest().to_string())
            .collect();
        return Err(format!(
            "interaction {interaction_id_raw:?} is exposed by {} reachable bindings, which is ambiguous: {}. Select one with --binding DIGEST",
            matches.len(),
            digests.join(", ")
        ));
    }

    matches
        .pop()
        .ok_or_else(|| "internal: no candidate binding survived resolution".to_owned())
}

/// The mode to invoke for one interaction id.
///
/// With `--mode`, exactly that mode or nothing: an operator who asked for the
/// gated path must not be silently given the direct one. Without it, the
/// *more* gated mode a binding exposes. Preferring Direct would let any
/// caller of `boundary call` step around an approval the application deliberately
/// required, which is authority granted by convenience rather than by
/// declaration.
fn select_mode(
    manifest: &BindingManifest,
    interaction_id: &InteractionId,
    requested: Option<InteractionMode>,
) -> Option<InteractionMode> {
    let available = manifest
        .interactions()
        .iter()
        .filter(|interaction| interaction.interaction_id() == interaction_id)
        .map(BoundInteraction::mode);
    match requested {
        Some(mode) => available.into_iter().find(|found| *found == mode),
        None => available.max(),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{InteractionId, InteractionMode, select_mode};
    use boundary_core::lifecycle::BindingManifest;

    /// The reviewed host-lifecycle vector already carries a Binding that
    /// exposes one interaction in **both** modes, which is exactly the case
    /// where picking a mode is a security decision rather than a detail.
    /// Reading it here rather than hand-assembling a manifest keeps the
    /// fixture something a reviewer already accepted.
    fn dual_mode_manifest() -> BindingManifest {
        let raw = include_str!("../../../tests/conformance/v1/host-lifecycle.json");
        let vector: serde_json::Value = serde_json::from_str(raw).expect("vector parses");
        serde_json::from_value(vector["artifacts"]["binding"].clone())
            .expect("the reviewed binding manifest decodes")
    }

    fn dual_mode_interaction() -> InteractionId {
        InteractionId::parse("todos.create").expect("interaction id")
    }

    /// Preferring Direct would let any caller of `boundary call` step around an
    /// approval the application deliberately required.
    #[test]
    fn without_a_requested_mode_the_more_gated_one_wins() {
        let manifest = dual_mode_manifest();
        let interaction = dual_mode_interaction();
        assert!(
            manifest
                .interactions()
                .iter()
                .any(|bound| bound.mode() == InteractionMode::Direct),
            "the fixture must actually offer the direct path this test refuses to take"
        );
        assert_eq!(
            select_mode(&manifest, &interaction, None),
            Some(InteractionMode::Request)
        );
    }

    #[test]
    fn an_explicit_mode_is_honored_in_both_directions() {
        let manifest = dual_mode_manifest();
        let interaction = dual_mode_interaction();
        assert_eq!(
            select_mode(&manifest, &interaction, Some(InteractionMode::Direct)),
            Some(InteractionMode::Direct)
        );
        assert_eq!(
            select_mode(&manifest, &interaction, Some(InteractionMode::Request)),
            Some(InteractionMode::Request)
        );
    }

    /// An interaction the Binding does not expose resolves to nothing in every
    /// mode, so a caller is told rather than quietly given something else.
    #[test]
    fn an_unexposed_interaction_resolves_to_nothing() {
        let manifest = dual_mode_manifest();
        let absent = InteractionId::parse("todos.nothing").expect("interaction id");
        assert_eq!(select_mode(&manifest, &absent, None), None);
        assert_eq!(
            select_mode(&manifest, &absent, Some(InteractionMode::Direct)),
            None
        );
    }
}
