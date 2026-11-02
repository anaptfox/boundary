//! Interaction identifier to WIT identifier derivation.
//!
//! Interaction ids follow the Program v1 token grammar,
//! `[A-Za-z0-9][A-Za-z0-9._~-]{0,127}`. WIT identifiers are lowercase kebab
//! segments, `[a-z][a-z0-9]*(-[a-z0-9]+)*`, and a small keyword set is
//! reserved. The two grammars do not correspond, so this module derives a name
//! and reports an exact failure rather than guessing.
//!
//! Derivation never invents authority or identity: the interaction id remains the
//! contract identity, and the derived name is only the WIT spelling of it. The
//! projection records both, so a reader can always recover the id.

use std::fmt;

/// Reserved WIT words that cannot be used as an identifier.
const WIT_KEYWORDS: &[&str] = &[
    "as",
    "bool",
    "borrow",
    "char",
    "constructor",
    "enum",
    "export",
    "f32",
    "f64",
    "flags",
    "from",
    "func",
    "future",
    "import",
    "include",
    "interface",
    "list",
    "option",
    "own",
    "package",
    "record",
    "resource",
    "result",
    "s16",
    "s32",
    "s64",
    "s8",
    "static",
    "stream",
    "string",
    "tuple",
    "type",
    "u16",
    "u32",
    "u64",
    "u8",
    "use",
    "variant",
    "with",
    "world",
];

/// Why an interaction id has no valid WIT spelling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NameErrorKind {
    /// Derivation produced no segments at all.
    Empty,
    /// A segment does not start with an ASCII lowercase letter.
    SegmentStart {
        /// The offending segment.
        segment: String,
    },
    /// A segment contains a character outside `[a-z0-9]`.
    SegmentCharacter {
        /// The offending segment.
        segment: String,
    },
    /// The derived name is a reserved WIT word.
    Reserved,
    /// Derivation succeeded but produced a name another source already
    /// derived. Distinct ids can reduce to one identifier (`a.bC` and
    /// `a.b-c` both give `a-b-c`), so derivation alone cannot keep them
    /// apart and whoever holds the map has to refuse the second one.
    Collision {
        /// The other source that derives the same identifier.
        with: String,
    },
}

impl fmt::Display for NameErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("derives no WIT identifier segments"),
            Self::SegmentStart { segment } => write!(
                formatter,
                "segment {segment:?} must begin with an ASCII lowercase letter"
            ),
            Self::SegmentCharacter { segment } => write!(
                formatter,
                "segment {segment:?} must contain only ASCII lowercase letters and digits"
            ),
            Self::Reserved => formatter.write_str("derives a reserved WIT keyword"),
            Self::Collision { with } => {
                write!(formatter, "derives the same WIT identifier as {with:?}")
            }
        }
    }
}

/// One interaction id that cannot be spelled as a WIT identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NameError {
    /// The interaction id that failed.
    pub interaction_id: String,
    /// The derived name at the point of failure, when one existed.
    pub derived: Option<String>,
    /// Why derivation failed.
    pub kind: NameErrorKind,
}

impl fmt::Display for NameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "interaction {:?} {}",
            self.interaction_id, self.kind
        )?;
        if let Some(derived) = &self.derived {
            write!(formatter, " (derived {derived:?})")?;
        }
        Ok(())
    }
}

impl std::error::Error for NameError {}

/// Splits an interaction id into lowercase segments.
///
/// Separators are `.`, `_`, `~`, and `-`. A lowercase-to-uppercase transition
/// also starts a new segment, so `makeThumbnail` becomes `make` and
/// `thumbnail`. A digit never starts a new segment, so `todos.v2` keeps `v2`
/// intact rather than producing an invalid leading-digit segment.
fn segments(interaction_id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous_lower_or_digit = false;

    for character in interaction_id.chars() {
        if matches!(character, '.' | '_' | '~' | '-') {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            previous_lower_or_digit = false;
            continue;
        }

        if character.is_ascii_uppercase() && previous_lower_or_digit && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }

        previous_lower_or_digit = character.is_ascii_lowercase() || character.is_ascii_digit();
        current.extend(character.to_lowercase());
    }

    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Derives the WIT identifier for one interaction id.
///
/// # Errors
///
/// Returns [`NameError`] when the id has no valid WIT spelling. The caller must
/// supply an explicit alias rather than have the projector invent one.
pub fn wit_identifier(interaction_id: &str) -> Result<String, NameError> {
    let parts = segments(interaction_id);
    if parts.is_empty() {
        return Err(NameError {
            interaction_id: interaction_id.to_owned(),
            derived: None,
            kind: NameErrorKind::Empty,
        });
    }

    for segment in &parts {
        let mut characters = segment.chars();
        let first = characters.next().unwrap_or('0');
        if !first.is_ascii_lowercase() {
            return Err(NameError {
                interaction_id: interaction_id.to_owned(),
                derived: Some(parts.join("-")),
                kind: NameErrorKind::SegmentStart {
                    segment: segment.clone(),
                },
            });
        }
        if !characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        {
            return Err(NameError {
                interaction_id: interaction_id.to_owned(),
                derived: Some(parts.join("-")),
                kind: NameErrorKind::SegmentCharacter {
                    segment: segment.clone(),
                },
            });
        }
    }

    let derived = parts.join("-");
    if WIT_KEYWORDS.contains(&derived.as_str()) {
        return Err(NameError {
            interaction_id: interaction_id.to_owned(),
            derived: Some(derived),
            kind: NameErrorKind::Reserved,
        });
    }
    Ok(derived)
}

#[cfg(test)]
mod tests {
    use super::{NameError, NameErrorKind, wit_identifier};

    #[test]
    fn splits_dots_and_camel_case() -> Result<(), NameError> {
        assert_eq!(
            wit_identifier("images.makeThumbnail")?,
            "images-make-thumbnail"
        );
        Ok(())
    }

    #[test]
    fn preserves_existing_kebab_segments() -> Result<(), NameError> {
        assert_eq!(
            wit_identifier("media.edit.set-node-transform")?,
            "media-edit-set-node-transform"
        );
        Ok(())
    }

    #[test]
    fn keeps_trailing_digits_inside_a_segment() -> Result<(), NameError> {
        assert_eq!(wit_identifier("todos.v2")?, "todos-v2");
        Ok(())
    }

    #[test]
    fn rejects_a_segment_starting_with_a_digit() {
        assert_eq!(
            wit_identifier("images.2x"),
            Err(NameError {
                interaction_id: "images.2x".to_owned(),
                derived: Some("images-2x".to_owned()),
                kind: NameErrorKind::SegmentStart {
                    segment: "2x".to_owned()
                },
            })
        );
    }

    #[test]
    fn rejects_a_reserved_keyword() {
        assert_eq!(
            wit_identifier("record"),
            Err(NameError {
                interaction_id: "record".to_owned(),
                derived: Some("record".to_owned()),
                kind: NameErrorKind::Reserved,
            })
        );
    }

    #[test]
    fn distinct_ids_can_derive_one_name() -> Result<(), NameError> {
        // The projector must detect this collision; derivation alone cannot.
        assert_eq!(wit_identifier("a.bC")?, "a-b-c");
        assert_eq!(wit_identifier("a.b-c")?, "a-b-c");
        Ok(())
    }
}
