use super::{ProjectError, ProjectionModes, ProjectionSelection, valid_alias};

/// Selects a host-authored native interaction under one alias.
///
/// # Errors
/// Returns an error for an invalid alias.
pub fn select_native(
    alias: impl Into<String>,
    interaction: &crate::lifecycle::NativeInteraction,
    modes: ProjectionModes,
) -> Result<ProjectionSelection, ProjectError> {
    let alias = alias.into();
    if !valid_alias(&alias) {
        return Err(ProjectError::InvalidAlias);
    }
    Ok(ProjectionSelection {
        alias,
        interaction: interaction.erased.clone(),
        modes,
    })
}
