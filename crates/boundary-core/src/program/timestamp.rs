//! Strict ISO-8601 timestamp validation for a Draft's `createdAt`.
//!
//! Boundary never reads a clock. A Draft's `createdAt` is host-supplied and only
//! checked for shape here: `YYYY-MM-DDTHH:MM:SS[.f+](Z|(+|-)HH:MM)`, with
//! calendar-aware day-of-month bounds and a leap-second allowance on the
//! seconds field. TypeScript ports this exact grammar in
//! `packages/core/program/draft.ts`; the shared conformance vector is the
//! check, not this comment.

/// Returns whether `value` is a valid ISO-8601 timestamp of the shape a
/// Draft requires.
pub(super) fn is_valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut pos = 0usize;

    let Some(year) = read_digits(bytes, &mut pos, 4) else {
        return false;
    };
    if !consume(bytes, &mut pos, b'-') {
        return false;
    }
    let Some(month) = read_digits(bytes, &mut pos, 2) else {
        return false;
    };
    if !(1..=12).contains(&month) {
        return false;
    }
    if !consume(bytes, &mut pos, b'-') {
        return false;
    }
    let Some(day) = read_digits(bytes, &mut pos, 2) else {
        return false;
    };
    if day < 1 || day > days_in_month(year, month) {
        return false;
    }
    if !consume(bytes, &mut pos, b'T') {
        return false;
    }
    let Some(hour) = read_digits(bytes, &mut pos, 2) else {
        return false;
    };
    if hour > 23 {
        return false;
    }
    if !consume(bytes, &mut pos, b':') {
        return false;
    }
    let Some(minute) = read_digits(bytes, &mut pos, 2) else {
        return false;
    };
    if minute > 59 {
        return false;
    }
    if !consume(bytes, &mut pos, b':') {
        return false;
    }
    let Some(second) = read_digits(bytes, &mut pos, 2) else {
        return false;
    };
    if second > 60 {
        return false;
    }

    if bytes.get(pos) == Some(&b'.') {
        pos += 1;
        let start = pos;
        while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if pos == start {
            return false;
        }
    }

    match bytes.get(pos) {
        Some(b'Z') => pos += 1,
        Some(b'+' | b'-') => {
            pos += 1;
            let Some(offset_hour) = read_digits(bytes, &mut pos, 2) else {
                return false;
            };
            if offset_hour > 23 {
                return false;
            }
            if !consume(bytes, &mut pos, b':') {
                return false;
            }
            let Some(offset_minute) = read_digits(bytes, &mut pos, 2) else {
                return false;
            };
            if offset_minute > 59 {
                return false;
            }
        }
        _ => return false,
    }

    pos == bytes.len()
}

/// Reads exactly `count` ASCII digits at `pos`, advancing past them.
fn read_digits(bytes: &[u8], pos: &mut usize, count: usize) -> Option<u32> {
    let start = *pos;
    let end = start.checked_add(count)?;
    let slice = bytes.get(start..end)?;
    let mut value = 0u32;
    for &byte in slice {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    *pos = end;
    Some(value)
}

/// Consumes one exact byte at `pos`, advancing past it on a match.
fn consume(bytes: &[u8], pos: &mut usize, expected: u8) -> bool {
    if bytes.get(*pos) == Some(&expected) {
        *pos += 1;
        true
    } else {
        false
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::is_valid_timestamp;

    #[test]
    fn accepts_a_utc_timestamp() {
        assert!(is_valid_timestamp("2026-09-06T12:00:00Z"));
    }

    #[test]
    fn accepts_fractional_seconds_and_an_offset() {
        assert!(is_valid_timestamp("2026-09-06T12:00:00.123+02:00"));
    }

    #[test]
    fn accepts_a_leap_day() {
        assert!(is_valid_timestamp("2024-02-29T00:00:00Z"));
    }

    #[test]
    fn accepts_a_leap_second() {
        assert!(is_valid_timestamp("2026-09-06T23:59:60Z"));
    }

    #[test]
    fn rejects_a_non_leap_day() {
        assert!(!is_valid_timestamp("2023-02-29T00:00:00Z"));
    }

    #[test]
    fn rejects_an_invalid_month() {
        assert!(!is_valid_timestamp("2026-13-01T00:00:00Z"));
    }

    #[test]
    fn rejects_a_missing_offset() {
        assert!(!is_valid_timestamp("2026-09-06T12:00:00"));
    }

    #[test]
    fn rejects_trailing_garbage() {
        assert!(!is_valid_timestamp("2026-09-06T12:00:00Zgarbage"));
    }

    #[test]
    fn rejects_an_empty_string() {
        assert!(!is_valid_timestamp(""));
    }

    #[test]
    fn rejects_a_lowercase_designator() {
        assert!(!is_valid_timestamp("2026-09-06t12:00:00z"));
    }
}
