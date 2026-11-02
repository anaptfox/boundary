//! `boundary mcp` — one Model Context Protocol server for this OS user.
//!
//! A model connects once and sees every interaction the applications on this
//! machine currently offer, instead of one server per application. Nothing
//! about that concentrates authority here: each application decides what it
//! shows, admits every call it receives, and holds the receipt for anything it
//! executed. This process resolves addresses and carries pins.
//!
//! The catalog is read once at startup. A surface that appears or disappears
//! later is not picked up until the server restarts, which is honest about
//! what it knows rather than pretending to a liveness it does not track.
//!
//! **The Projection is the only narrowing.** Every interaction on a reachable
//! Binding's manifest becomes a tool. There is no second, softer list an
//! application could use to hide one, so there is nothing for this process to
//! fail to honour: an application that wants a model to see less publishes a
//! smaller Projection, which also keeps the interaction out of the Binding.
//! Admission is still the gate on every call.

use std::io::{BufReader, Write};
use std::path::Path;

use boundary_bus::{BusClient, Request, Response};
use boundary_core::InteractionId;
use boundary_core::handoff::HandoffInvocation;
use boundary_core::lifecycle::{BindingManifest, InteractionMode};
use boundary_mcp::{ServerInfo, ToolEntry, ToolInvoker, ToolTarget, merge, tools_from_manifest};
use boundary_reach::{ReachRecord, Transport, fetch_manifest, invoke};
use serde_json::Value;

/// Reaches surfaces over the transport their Reach record was read from.
struct ReachInvoker {
    /// One entry per surface: the validated manifest to build invocations
    /// from, and the one transport that served its manifest.
    surfaces: Vec<(BindingManifest, Transport)>,
}

impl ToolInvoker for ReachInvoker {
    fn invoke(&self, target: &ToolTarget, input: Value) -> Result<Value, String> {
        let (manifest, transport) = self
            .surfaces
            .iter()
            .find(|(manifest, _)| manifest.binding_digest().to_string() == target.binding_digest)
            .ok_or_else(|| format!("no surface for binding {}", target.binding_digest))?;

        let interaction_id = InteractionId::parse(&target.interaction_id)
            .map_err(|error| format!("invalid interaction id: {error}"))?;
        let mode = match target.mode.as_str() {
            "request" => InteractionMode::Request,
            _ => InteractionMode::Direct,
        };
        // The invocation is built from the manifest this server validated at
        // startup, so every pin comes from a checked artifact rather than from
        // whatever a model happened to send back. The model supplies input and
        // nothing else, and the receiving host validates all of it again.
        let invocation = HandoffInvocation::new(manifest, &interaction_id, mode, input)
            .map_err(|error| format!("invocation rejected before sending: {error}"))?;

        // Exactly one transport per invocation. A record may list several
        // ways to reach the same Binding, and trying the next one after a
        // transport failure would re-send an invocation the first host may
        // already have executed — the effect applied twice, reported once.
        // A transport failure *is* the uncertain outcome; the layer above
        // already says so (`boundary_mcp::server`: an unreachable surface is
        // not "did not happen"). Manifest fetching may try every transport,
        // because `GET /manifest` is safe to repeat; `invoke` is not.
        let outcome = invoke(transport, &invocation).map_err(|error| error.to_string())?;
        serde_json::to_value(&outcome)
            .map_err(|error| format!("outcome could not be rendered: {error}"))
    }
}

/// Reads what is reachable and turns it into a tool catalog.
///
/// A surface that cannot be reached is skipped with a note on stderr rather
/// than failing the whole server: one unreachable application must not deny a
/// model every other application on the machine.
fn collect(socket: &Path) -> Result<(Vec<ToolEntry>, ReachInvoker), String> {
    let mut client = BusClient::connect(socket).map_err(|error| {
        format!(
            "could not reach the bus at {}: {error}. Is `boundary bus` running?",
            socket.display()
        )
    })?;
    let records: Vec<ReachRecord> = match client
        .send(&Request::List)
        .map_err(|error| error.to_string())?
    {
        Response::Ok { records } => records,
        Response::Error { code, message } => return Err(format!("{code}: {message}")),
    };

    let mut catalogs = Vec::new();
    let mut surfaces = Vec::new();
    for record in records {
        // Fetching a manifest may try every transport: `GET /manifest` is
        // safe to repeat. The transport that answered is the one kept, so
        // the single invocation later goes somewhere already proved
        // reachable rather than to whichever the record happened to list
        // first.
        let mut fetched = None;
        for transport in record.transports() {
            match fetch_manifest(transport) {
                Ok(manifest) => {
                    fetched = Some((transport.clone(), manifest));
                    break;
                }
                Err(error) => {
                    eprintln!(
                        "boundary mcp: skipping {}: {error}",
                        record.binding_digest()
                    );
                }
            }
        }
        // `fetch_manifest` decodes through the validating `BindingManifest`
        // type, so a malformed or tampered wire representation never reaches
        // here at all. The manifest is kept, not discarded: invocations are
        // built from it later, so the pins a model calls with come from a
        // checked artifact rather than from whatever it echoed back.
        let Some((transport, manifest)) = fetched else {
            continue;
        };

        let value = serde_json::to_value(&manifest)
            .map_err(|error| format!("manifest could not be read: {error}"))?;
        let tools = match tools_from_manifest(&value) {
            Ok(tools) => tools,
            Err(error) => {
                // A manifest this process cannot turn into tools costs that
                // surface its tools and nothing more. An unusable alias is
                // chosen by whoever served the manifest, so letting it fail
                // the catalog would hand any surface a way to deny the rest.
                eprintln!(
                    "boundary mcp: skipping {}: {error}",
                    manifest.binding_digest()
                );
                continue;
            }
        };
        catalogs.push(tools);
        surfaces.push((manifest, transport));
    }

    let merged = merge(catalogs);
    for duplicate in &merged.dropped {
        eprintln!(
            "boundary mcp: dropping tool {:?}, claimed by {}",
            duplicate.name,
            duplicate.bindings.join(", ")
        );
    }
    Ok((merged.entries, ReachInvoker { surfaces }))
}

/// Serves the protocol on stdio until the client closes it.
///
/// # Errors
///
/// Returns a message when the bus cannot be reached or the catalog cannot be
/// built. Stream failures after that end the session rather than erroring.
pub(crate) fn run(socket: &Path) -> Result<(), String> {
    let (entries, invoker) = collect(socket)?;
    eprintln!(
        "boundary mcp: serving {} tool(s) from {} surface(s)",
        entries.len(),
        invoker.surfaces.len()
    );

    let info = ServerInfo {
        name: "boundary".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut output = stdout.lock();

    boundary_mcp::serve(&mut input, &mut output, &info, &entries, &invoker)
        .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}
