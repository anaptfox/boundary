#![doc = "Interaction implementation plugins for interaction-first programs."]
#![forbid(unsafe_code)]

//! A component is a realization kind, never the kernel. The Program, its
//! contracts, and their identities stay in `boundary-core`; this crate spells one
//! Program as a WIT world so a plugin author can implement its interactions in
//! any guest language, and a host can bind that plugin under an explicit
//! import map.
//!
//! Two rules shape every decision here:
//!
//! - **Authority is absence.** A plugin reaches only the host functions the host
//!   maps by name. The bind-time subset check enforces that a component asks for
//!   nothing outside the map. It does not, and cannot, enforce that a mapped
//!   host function honors its declared read or change class; that stays a host
//!   review obligation exactly as it is for a native handler.
//! - **Context never crosses.** The opaque per-invocation context is never
//!   serialized and never reaches plugin code. A host function closes over its
//!   own context on the host side.

mod component;
mod imports;
mod limits;
mod name;
mod runtime;
mod wit;

pub use boundary_core::lifecycle::InvocationCertainty;
pub use component::{PluginComponent, PluginError, PluginLifetime, RequiredImport};
pub use imports::{HostImport, HostImports, ImportCheck};
pub use limits::{GuestLimits, guest_engine};
pub use name::{NameError, NameErrorKind, wit_identifier};
pub use runtime::{GuestInstance, GuestOutcome, HostFunction, HostFunctions, HostReply};
pub use wit::{
    ProjectedInteraction, WitProjection, WitProjectionError, WitProjectionOptions, project_wit,
};
