#![doc = "Per-user local bus for Reach records."]
#![forbid(unsafe_code)]

//! A resolver, not a broker. The bus answers where a Binding can be reached
//! and holds nothing else: no authority, no invocation context, and no record
//! of what anyone called. A caller that finds an address reaches it directly,
//! so the bus never sits in the call path and never becomes a second source of
//! truth about outcomes. Receipts stay with Control in the application that
//! executed the effect.
//!
//! Trust is the OS user. There is no network listener and no registry beyond
//! this machine: federated discovery across trust boundaries is a governance
//! problem rather than a protocol one, and the systems that tried to solve it
//! with a protocol are not around to argue.

mod possession;
mod protocol;
mod registry;
#[cfg(unix)]
mod socket;

#[cfg(unix)]
pub use possession::{PossessionProof, prove_possession_by_manifest};
pub use protocol::{Request, Response};
pub use registry::{ConnectionId, Registry, RegistryError};
pub use socket::{BusClient, BusError, BusServer};
