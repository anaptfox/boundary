//! Proving a registrant holds the Binding it claims.
//!
//! Ownership inside the registry only stops a *second* connection taking over
//! a digest a live one already holds. First registration is the gap: binding
//! digests are content-derived and published, so a claim by itself is worth
//! nothing. This module is what makes a claim cost something.

use std::sync::Arc;

use boundary_reach::ReachRecord;

/// Proves a registrant actually holds the Binding it claims.
///
/// Returns `Ok(())` when the claim stands, or a reason to refuse.
pub type PossessionProof = Arc<dyn Fn(&ReachRecord) -> Result<(), String> + Send + Sync>;

/// The default proof: fetch the manifest the record points at, and require it
/// to be the Binding the record names.
///
/// Without this, first registration of a digest is unauthenticated. Binding
/// digests are content-derived and published, so any process running as this
/// user could claim a legitimate application's digest before that application
/// starts, capture every input a caller sends, and forge outcomes back. The
/// registry's ownership rules do not help: they only stop a *second*
/// connection taking over a digest a live one already holds.
///
/// One round trip turns squatting from free into "must also serve a valid
/// manifest for a Binding you do not have". The cost is that a host must be
/// listening before it registers, which is the correct order anyway: a record
/// naming an address that does not answer is not yet reachable.
///
/// This is not an authentication boundary against a determined local
/// attacker, who can still race the real application to the port. It removes
/// the free case, which is the one that matters.
///
/// # Errors
///
/// Returns a reason to refuse when no transport serves a manifest, or when
/// the manifest it serves names a different Binding than the record claims.
pub fn prove_possession_by_manifest(record: &ReachRecord) -> Result<(), String> {
    let mut failures = Vec::new();
    for transport in record.transports() {
        match boundary_reach::fetch_manifest(transport) {
            Ok(manifest) => {
                let served = manifest.binding_digest().to_string();
                if served == record.binding_digest() {
                    return Ok(());
                }
                return Err(format!(
                    "the surface serves binding {served}, not the claimed {}",
                    record.binding_digest()
                ));
            }
            Err(error) => failures.push(error.to_string()),
        }
    }
    Err(format!(
        "no transport served a manifest to prove possession: {}",
        failures.join("; ")
    ))
}
