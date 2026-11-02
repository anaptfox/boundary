# `@foxworth/boundary/program`

Interaction contracts, identity, Programs, compatibility, portable schemas, and
the optional `@foxworth/boundary/program/zod` authoring adapter. This package describes
work; it does not own execution or host policy.

The package root does not require Zod. Importing `@foxworth/boundary/program/zod`
requires the optional `zod` peer dependency at `^4.6.5`.

`contractChanges(before, after)` returns immutable field changes and the
directional `contractCompatibility` judgment for existing callers. It enables
declaration review and upgrade explanations; the host owns acceptance and
execution. Dotted paths are display labels, arrays are whole-value changes, and
footprints are normalized first. The report has no portable wire or identity
contract. See the [Program reference](../../../docs/reference/program.md#explaining-a-contract-change).
