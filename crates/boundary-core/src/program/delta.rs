//! What moved between two versions of one interaction contract.
//!
//! A changed contract digest says *that* a declaration changed; this says
//! *where*, so the person accepting the change reviews specific declared
//! content instead of two opaque hashes. It also reports whether callers
//! built for the old contract can still be served by the new one, using the
//! same directional judgment Binding uses ([`contract_compatibility`]).
//!
//! This is evidence about declarations only. It says nothing about whether
//! the realization behind either contract behaves the same.
//!
//! A native presentation aid, also available in TypeScript, with no wire
//! schema, identity, or shared portable output guarantee. The compatibility
//! laws remain covered by shared conformance evidence. The host owns change
//! acceptance and execution; an atomic Binding checks compatibility.

use serde_json::Value;

use super::{Compatibility, InteractionContract, contract_compatibility};

/// How one declared element changed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeKind {
    /// Present only in the newer contract.
    Added,
    /// Present only in the older contract.
    Removed,
    /// Present in both with a different value.
    Changed,
}

/// One moved element with a dotted display label into the contract's
/// portable JSON form (for example `outputSchema.properties.reply_url`).
/// Literal periods in keys can make labels ambiguous; they are not addresses
/// or patch instructions. Arrays are reported as whole values.
#[derive(Clone, Debug, PartialEq)]
pub struct ContractChange {
    /// A display label for the changed element.
    pub path: String,
    /// What happened there.
    pub kind: ChangeKind,
    /// The older value, when there was one.
    pub before: Option<Value>,
    /// The newer value, when there is one.
    pub after: Option<Value>,
}

/// Everything that moved from `before` to `after`, plus whether a caller
/// built for `before` can be bound to a realization of `after`.
#[derive(Clone, Debug, PartialEq)]
pub struct ContractDelta {
    /// Moved elements, in path order. Empty when the declarations match.
    pub changes: Vec<ContractChange>,
    /// [`contract_compatibility`] with `before` as expected and `after` as
    /// offered.
    pub existing_callers: Compatibility,
}

impl ContractDelta {
    /// Whether nothing declared moved.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

/// Explains what moved from `before` to `after`. Contracts already contain
/// normalized footprints; the report owns snapshots of changed values.
#[must_use]
pub fn contract_changes(
    before: &InteractionContract,
    after: &InteractionContract,
) -> ContractDelta {
    let mut changes = Vec::new();
    diff("", &portable(before), &portable(after), &mut changes);
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    ContractDelta {
        changes,
        existing_callers: contract_compatibility(before, after),
    }
}

fn portable(contract: &InteractionContract) -> Value {
    // `InteractionContract` serializes to its portable form; failure would
    // mean a contract that could never have been built.
    serde_json::to_value(contract).unwrap_or(Value::Null)
}

fn join(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_owned()
    } else {
        format!("{prefix}.{key}")
    }
}

fn diff(path: &str, before: &Value, after: &Value, out: &mut Vec<ContractChange>) {
    match (before, after) {
        (Value::Object(old), Value::Object(new)) => {
            for (key, old_value) in old {
                match new.get(key) {
                    Some(new_value) => diff(&join(path, key), old_value, new_value, out),
                    None => out.push(ContractChange {
                        path: join(path, key),
                        kind: ChangeKind::Removed,
                        before: Some(old_value.clone()),
                        after: None,
                    }),
                }
            }
            for (key, new_value) in new {
                if !old.contains_key(key) {
                    out.push(ContractChange {
                        path: join(path, key),
                        kind: ChangeKind::Added,
                        before: None,
                        after: Some(new_value.clone()),
                    });
                }
            }
        }
        _ if before == after => {}
        _ => out.push(ContractChange {
            path: path.to_owned(),
            kind: ChangeKind::Changed,
            before: Some(before.clone()),
            after: Some(after.clone()),
        }),
    }
}
