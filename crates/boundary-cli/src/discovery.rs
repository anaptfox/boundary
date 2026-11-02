//! CLI discovery: inspect advertised Bindings without treating location as authority.

use std::path::Path;

use boundary_bus::{Request, Response};
use boundary_core::lifecycle::{BindingManifest, InteractionMode};
use boundary_reach::{ReachRecord, Transport, fetch_manifest};

use crate::{connect, describe};

pub(crate) fn reachable_records(socket: &Path) -> Result<Vec<ReachRecord>, String> {
    let mut client = connect(socket)?;
    match client
        .send(&Request::List)
        .map_err(|error| error.to_string())?
    {
        Response::Ok { records } => Ok(records),
        Response::Error { code, message } => Err(format!("{code}: {message}")),
    }
}

/// Read-only fallback stays within one record and accepts only its exact identity.
/// Invocation uses the returned transport once; it does not inherit this fallback.
pub(crate) fn inspect_record(record: &ReachRecord) -> Result<(Transport, BindingManifest), String> {
    let mut errors = Vec::new();
    for transport in record.transports() {
        match fetch_manifest(transport) {
            Ok(manifest)
                if manifest.binding_digest().as_str() == record.binding_digest()
                    && manifest.installation_id().as_str() == record.installation_id() =>
            {
                return Ok((transport.clone(), manifest));
            }
            Ok(manifest) => errors.push(format!(
                "{} serves Binding {} / Installation {}, expected {} / {}",
                describe(transport),
                manifest.binding_digest(),
                manifest.installation_id(),
                record.binding_digest(),
                record.installation_id(),
            )),
            Err(error) => errors.push(format!("{}: {error}", describe(transport))),
        }
    }
    Err(errors.join("; "))
}

pub(crate) fn list(socket: &Path) -> Result<(), String> {
    let records = reachable_records(socket)?;
    if records.is_empty() {
        println!("No reachable bindings. A host registers when it installs.");
        return Ok(());
    }
    let mut failures = 0;
    for record in &records {
        match inspect_record(record) {
            Ok((transport, manifest)) => {
                println!("{}", manifest.binding_digest());
                println!("  installation  {}", manifest.installation_id());
                println!("  inspected at  {}", describe(&transport));
                if manifest.interactions().is_empty() {
                    println!("  no selected interactions");
                }
                for interaction in manifest.interactions() {
                    let mode = match interaction.mode() {
                        InteractionMode::Direct => "direct",
                        InteractionMode::Request => "request",
                    };
                    println!("  interaction   {} [{mode}]", interaction.interaction_id());
                }
            }
            Err(reason) => {
                failures += 1;
                eprintln!(
                    "{}: manifest unavailable: {reason}",
                    record.binding_digest()
                );
            }
        }
    }
    if failures == 0 {
        Ok(())
    } else {
        Err(format!(
            "listing is incomplete: could not inspect {failures} of {} advertised Bindings",
            records.len(),
        ))
    }
}
