//! Scoped footprint template validation, matching, and runtime resolution.

use serde_json::Value;

use super::{ProgramError, ProgramErrorCode};

#[derive(Debug, Eq, PartialEq)]
enum Part<'a> {
    Literal(&'a str),
    Slot,
}

pub(super) fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

fn parse(value: &str) -> Option<Vec<Part<'_>>> {
    if !value.contains(['{', '}']) {
        return Some(vec![Part::Literal(value)]);
    }
    let mut parts = Vec::new();
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        let (literal, after_open) = rest.split_at(open);
        if literal.contains('}') {
            return None;
        }
        if !literal.is_empty() {
            parts.push(Part::Literal(literal));
        }
        let after_open = &after_open[1..];
        let close = after_open.find('}')?;
        let (placeholder, after_close) = after_open.split_at(close);
        let path = placeholder.strip_prefix("input.")?;
        if !valid_path(path) {
            return None;
        }
        parts.push(Part::Slot);
        rest = &after_close[1..];
    }
    if rest.contains('}') {
        return None;
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest));
    }
    if parts.iter().any(|part| matches!(part, Part::Slot)) {
        Some(parts)
    } else {
        None
    }
}

pub(super) fn validate_footprint(value: &str, path: &str) -> Result<(), ProgramError> {
    if value.trim() != value || value.is_empty() || parse(value).is_none() {
        return Err(ProgramError::new(
            ProgramErrorCode::InvalidFootprint,
            path,
            "footprint must be non-empty, trimmed text with valid {input.<path>} placeholders",
        ));
    }
    Ok(())
}

/// Returns whether `expected` covers the footprint declared by `offered`.
#[must_use]
pub fn footprint_subsumes(expected: &str, offered: &str) -> bool {
    if expected == offered {
        return true;
    }
    let Some(expected_parts) = parse(expected) else {
        return false;
    };
    let Some(offered_parts) = parse(offered) else {
        return false;
    };
    let expected_has_slots = expected_parts.iter().any(|p| matches!(p, Part::Slot));
    let offered_has_slots = offered_parts.iter().any(|p| matches!(p, Part::Slot));
    if !expected_has_slots {
        return offered.starts_with(expected)
            && offered
                .strip_prefix(expected)
                .is_some_and(|suffix| suffix.starts_with(':') && suffix.len() > 1);
    }
    if offered_has_slots {
        return false;
    }
    match_parts(&expected_parts, offered.as_bytes(), 0, 0)
}

fn match_parts(parts: &[Part<'_>], value: &[u8], part_index: usize, offset: usize) -> bool {
    if part_index == parts.len() {
        return offset == value.len();
    }
    match parts[part_index] {
        Part::Literal(literal) => {
            let bytes = literal.as_bytes();
            value
                .get(offset..)
                .is_some_and(|tail| tail.starts_with(bytes))
                && match_parts(parts, value, part_index + 1, offset + bytes.len())
        }
        Part::Slot => {
            let Some(next) = parts.get(part_index + 1) else {
                return offset < value.len() && !value[offset..].contains(&b':');
            };
            match next {
                Part::Literal(literal) if !literal.is_empty() => {
                    let needle = literal.as_bytes();
                    (offset + 1..=value.len())
                        .filter(|end| {
                            value
                                .get(*end..)
                                .is_some_and(|tail| tail.starts_with(needle))
                        })
                        .any(|end| {
                            !value[offset..end].contains(&b':')
                                && match_parts(parts, value, part_index + 1, end)
                        })
                }
                Part::Slot => {
                    let end = value[offset..]
                        .iter()
                        .position(|byte| *byte == b':')
                        .map_or(value.len(), |length| offset + length);
                    (offset + 1..=end)
                        .any(|candidate| match_parts(parts, value, part_index + 1, candidate))
                }
                Part::Literal(_) => {
                    let end = value[offset..]
                        .iter()
                        .position(|byte| *byte == b':')
                        .map_or(value.len(), |length| offset + length);
                    end > offset && match_parts(parts, value, part_index + 1, end)
                }
            }
        }
    }
}

/// Resolves scoped footprint templates against one JSON input value.
#[must_use]
pub fn resolve_footprints(templates: &[String], input: &Value) -> Vec<String> {
    let mut resolved = Vec::new();
    for template in templates {
        let Some(parts) = parse(template) else {
            resolved.push(template.clone());
            continue;
        };
        if !parts.iter().any(|part| matches!(part, Part::Slot)) {
            resolved.push(template.clone());
            continue;
        }
        let mut output = String::new();
        let mut rest = template.as_str();
        let mut failed = false;
        while let Some(open) = rest.find('{') {
            output.push_str(&rest[..open]);
            let after_open = &rest[open + 1..];
            let Some(close) = after_open.find('}') else {
                failed = true;
                break;
            };
            let path = &after_open[..close];
            let Some(value) = path
                .strip_prefix("input.")
                .and_then(|path| lookup(input, path))
            else {
                failed = true;
                break;
            };
            match value {
                Value::String(value) => output.push_str(value),
                Value::Number(value) => output.push_str(&value.to_string()),
                Value::Bool(value) => output.push_str(&value.to_string()),
                _ => {
                    failed = true;
                    break;
                }
            }
            rest = &after_open[close + 1..];
        }
        if failed {
            let coarse = template.split(':').next().unwrap_or_default();
            resolved.push(if !coarse.is_empty() && !coarse.contains('{') {
                coarse.to_owned()
            } else {
                template.clone()
            });
        } else {
            output.push_str(rest);
            resolved.push(output);
        }
    }
    resolved.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    resolved.dedup();
    resolved
}

fn lookup<'a>(input: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(input, |value, key| value.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_subsumption_matches_templates_and_concrete_scopes() {
        assert!(footprint_subsumes("documents", "documents:{input.id}"));
        assert!(footprint_subsumes("documents", "documents:doc-1"));
        assert!(footprint_subsumes(
            "documents:{input.id}",
            "documents:doc-1"
        ));
        assert!(!footprint_subsumes(
            "documents:doc-1",
            "documents:{input.id}"
        ));
        assert!(footprint_subsumes(
            "org:{input.org}:doc:{input.id}",
            "org:acme:doc:99"
        ));
        assert!(footprint_subsumes("{input.first}{input.second}", "xy"));
    }

    #[test]
    fn scoped_resolution_uses_scalars_and_coarse_fallbacks() {
        let input = serde_json::json!({"org":{"id":"acme"},"id":12,"bad":null});
        assert_eq!(
            resolve_footprints(
                &[
                    "doc:{input.id}".to_owned(),
                    "org:{input.org.id}:doc:{input.id}".to_owned(),
                    "other:{input.missing}".to_owned(),
                    "item:{input.bad}".to_owned(),
                ],
                &input
            ),
            vec!["doc:12", "item", "org:acme:doc:12", "other"]
        );
    }
}
