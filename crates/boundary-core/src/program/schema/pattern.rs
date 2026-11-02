use super::{ProgramError, schema_error};
use serde_json::Value;
use std::{fmt, sync::Arc};

#[derive(Clone)]
pub(crate) struct CachedRegex(Arc<regress::Regex>);

impl CachedRegex {
    fn new(regex: regress::Regex) -> Self {
        Self(Arc::new(regex))
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        self.0.find(text).is_some()
    }
}

/// A cache derived entirely from `SchemaAst::pattern`, which is compared
/// directly; two caches never decide equality on their own.
impl PartialEq for CachedRegex {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

impl fmt::Debug for CachedRegex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CachedRegex")
    }
}

pub(super) fn optional_pattern(
    value: Option<&Value>,
    path: &str,
) -> Result<(Option<String>, Option<CachedRegex>), ProgramError> {
    let Some(value) = value else {
        return Ok((None, None));
    };
    let pattern = value
        .as_str()
        .ok_or_else(|| schema_error(path, "pattern must be a string"))?;
    let regex = regress::Regex::new(pattern).map_err(|_| {
        schema_error(
            path,
            "pattern must be a valid ECMAScript regular expression",
        )
    })?;
    Ok((Some(pattern.to_owned()), Some(CachedRegex::new(regex))))
}
