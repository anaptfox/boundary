use serde::{Deserialize, Serialize};

/// What the host can safely claim about whether an invocation took effect.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InvocationCertainty {
    /// No interaction effect began.
    NotStarted,
    /// The interaction began and is known not to have completed.
    NotCompleted,
    /// The declared interaction effect completed.
    Completed,
    /// The host cannot safely claim whether the interaction completed.
    Unknown,
}

/// Stable portable category of an invocation result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InvocationResultKind {
    /// Direct execution returned its declared output.
    Returned,
    /// Direct execution returned its exact declared error.
    DeclaredError,
    /// Request mode produced public proposal data without applying the interaction.
    Proposed,
    /// Admission denied the invocation before it started.
    Denied,
    /// A stable lifecycle or realization fault occurred.
    Fault,
}
