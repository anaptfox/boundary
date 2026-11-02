//! Compiler-diagnostic acceptance tests for the optional derives.

#[test]
fn interaction_metadata_errors_are_spanned() {
    let tests = trybuild::TestCases::new();
    tests.compile_fail("tests/ui/*.rs");
}
