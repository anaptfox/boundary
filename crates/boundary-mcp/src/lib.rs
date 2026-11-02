#![doc = "Model Context Protocol server over reachable interaction surfaces."]
#![forbid(unsafe_code)]

//! One server per OS user, exposing every interaction the applications on this
//! machine currently offer. A model connects once instead of once per
//! application, and nothing about that changes who decides:
//!
//! - each application narrows what it shows by publishing a narrower
//!   Projection; nothing here hides an interaction a Binding still carries;
//! - each application admits every call it receives;
//! - a consequential interaction stays behind request mode and its approval;
//! - receipts stay with the application that executed the effect.
//!
//! The model is an ordinary caller that late-binds intent to interactions. It is
//! not privileged here, and this crate holds no authority of its own.

mod server;
mod tools;

pub use server::{PROTOCOL_VERSION, ServerInfo, ToolInvoker, handle, serve, tool_result};
pub use tools::{
    DuplicateName, MergedTools, Tool, ToolEntry, ToolError, ToolTarget, merge, tools_from_manifest,
};
