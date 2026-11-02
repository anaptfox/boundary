use super::{InteractionContract, schema_compatibility::accepts_every};

/// Directional compatibility judgment between an expected and offered contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Compatibility {
    /// Every expected call and offered result remains safe.
    Compatible,
    /// The offered contract violates one directional rule.
    Incompatible {
        /// Stable path to the incompatible contract element.
        path: String,
        /// Human-readable explanation.
        reason: String,
    },
}

impl Compatibility {
    /// Returns whether the offered contract can safely replace the expected one.
    #[must_use]
    pub const fn is_compatible(&self) -> bool {
        matches!(self, Self::Compatible)
    }
}

/// Footprints `offered` declares that `expected` does not.
///
/// Footprints are directional like the schemas around them: an implementation
/// that reads or changes *less* than the caller was told to expect can serve
/// that caller, because the caller already budgets for the wider set. One that
/// touches *more* cannot — it would invalidate reads the caller never planned
/// to refresh and reach state the caller never agreed to.
fn footprint_excess(expected: &[String], offered: &[String]) -> Vec<String> {
    let mut excess: Vec<String> = offered
        .iter()
        .filter(|name| !expected.contains(name))
        .cloned()
        .collect();
    excess.sort();
    excess.dedup();
    excess
}

/// Checks whether `offered` can safely serve a caller built for `expected`.
///
/// Inputs are contravariant, outputs and errors are covariant, and footprints
/// are covariant too: the offered contract may read and change a subset of
/// what the expected contract declares, never a superset.
#[must_use]
pub fn contract_compatibility(
    expected: &InteractionContract,
    offered: &InteractionContract,
) -> Compatibility {
    if expected.id() != offered.id() {
        return incompatible("id", "interaction ids differ");
    }
    let extra_reads = footprint_excess(expected.reads(), offered.reads());
    if !extra_reads.is_empty() {
        return incompatible(
            "reads",
            format!(
                "offered reads exceed the expected footprint: {}",
                extra_reads.join(", ")
            ),
        );
    }
    let extra_changes = footprint_excess(expected.changes(), offered.changes());
    if !extra_changes.is_empty() {
        return incompatible(
            "changes",
            format!(
                "offered changes exceed the expected footprint: {}",
                extra_changes.join(", ")
            ),
        );
    }
    let input = accepts_every(
        offered.input_schema(),
        expected.input_schema(),
        "inputSchema",
        false,
    );
    if !input.is_compatible() {
        return input;
    }
    let output = accepts_every(
        expected.output_schema(),
        offered.output_schema(),
        "outputSchema",
        true,
    );
    if !output.is_compatible() {
        return output;
    }
    match (expected.error_schema(), offered.error_schema()) {
        (_, None) => Compatibility::Compatible,
        (None, Some(_)) => incompatible(
            "errorSchema",
            "offered errors are not declared by the expected contract",
        ),
        (Some(expected), Some(offered)) => accepts_every(expected, offered, "errorSchema", true),
    }
}

fn incompatible(path: impl Into<String>, reason: impl Into<String>) -> Compatibility {
    Compatibility::Incompatible {
        path: path.into(),
        reason: reason.into(),
    }
}
