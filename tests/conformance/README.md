# Cross-language conformance

The files in this directory are reviewed semantic evidence, not an authored
interaction language and not generated output from whichever implementation ran
last.

The `v1/` evidence is consumed independently by the Rust and TypeScript
implementations. `program.json` establishes canonical JSON, contract identity,
and Program identity under the normative v1 domains. `contract-compatibility.json`
establishes directional `contractCompatibility` on the portable schema profile:
IDs, footprints, input/output/error schemas, and combinators. `host-lifecycle.json`
establishes the application-owned interaction lifecycle and its four consequence
certainties. `composition.json` covers empty surfaces, observation envelopes,
and the independent presentation digest. Its presentation golden was calculated
with an independent SHA-256 implementation over reviewed canonical JSON, not
exported from either runtime.

`binding-restriction.json` establishes subset selection, oldest-parent-first
admission, revocation lineage, and unchanged portable identity when only private
policy changes. Both native suites consume its admission and subset cases
independently. `observed-reads.json` establishes point presence/content and query
answer validation, including membership, ordering, and pagination changes. The
implementation suites additionally use incomplete-evidence negative controls so
comparison with fresh evaluation detects a wrong reused result. These cases test the supplied adapter;
they do not prove completeness of arbitrary host adapters or evaluator purity.

`wasm-import-subset.json` is the bind-time guest import check: both languages
read the same fixture components and must emit the same refusal report.

A cross-language semantic change must update every affected implementation and
the reviewed conformance evidence in the same change. A gate may verify vectors
but must never rewrite them.

The identity goldens were computed independently using Python SHA-256 over the
reviewed identity inputs, with UTF-8 key ordering and integral number
normalization, rather than copied from a runtime emitter. Installation, Binding,
and presentation digests include the identities they reference.
