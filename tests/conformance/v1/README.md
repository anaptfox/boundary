# Version 1 cross-language evidence

`program.json` records the canonical contract and Program identity vectors for
the normative v1 domains.

`contract-compatibility.json` records directional `contractCompatibility` cases
on the shared portable schema profile. Each case overlays `defaults` with
`expected` and `offered` at the contract top level. An implementation consuming
this vector must agree on the boolean judgment. Reason strings and JSON paths
are language-local. `not` is only established when the compared schemas are
identical; unequal schemas that both carry `not` are outside this evidence.

`host-lifecycle.json` records implementation-independent examples for the
application-owned interaction lifecycle. It is reviewed evidence, never generated
from one implementation.

An implementation consuming this vector must establish all of these laws:

- contract and Program identity pins are stable;
- a Projection durably retains its caller alias, exact contract, input arity,
  and the closed set of `direct` and/or `request` modes before realization;
- a durable alias is part of Projection identity, so renaming it changes the
  Projection digest;
- an Installation and each mode realization have distinct host-issued IDs;
- binding is atomic: it yields either one complete binding or unrealized data,
  never a partial caller;
- a bound manifest pins the expected and actual contract identities,
  Installation ID, realization ID, and exact mode;
- compatibility is directional from the Projection's expected contract to the
  Installation's actual contract; the compatible nonidentical vector pins
  distinct contract and Program digests and proves that reversing the direction
  is incompatible;
- invocation outcomes retain all four consequence certainties. A successful
  direct call is `completed`, a proposal or denial is `not-started`, a fault
  after execution began may be `not-completed` only when non-completion is
  proved, and an unexpected direct failure is `unknown` when completion cannot
  be proved. `not-completed` does not prove the absence of partial effects and
  does not authorize automatic retry.

Language-specific representations may contain more evidence. They may not erase
or weaken these laws.

`handoff-response.json` enumerates the seven response identity fields that must
match the sent invocation. TypeScript's response checker and Rust's native
remote caller independently consume these cases. Invalid or lost responses
remain unknown and never authorize an automatic retry. This evidence proves
identity correlation, not that a result was computed from the requested input.

`execution-evidence.json` establishes the separate v1 causal evidence envelope:
explicit namespaced entity references, unchanged invocation observations,
completed status reads alongside uncertain subjects, absent evidence, and local
duplicate/self/conflicting-link refusals. It does not authenticate publisher
claims, establish global ordering, grant authority, or authorize retry.

`nullable-authoring.json` establishes the portable value laws of normalized
nullable schemas, including sibling restrictions and nested bounds. Both native
implementations validate the reviewed output independently; only TypeScript's
Zod adapter generates these schemas. The portable profile still rejects raw
type arrays.

`portable-collections.json` establishes tuples (`prefixItems` with `items` as a
schema or `false`) and string-keyed records (`propertyNames`) in the portable
profile: value laws, refused malformed keywords, and the reviewed contracts that
Zod (`z.tuple`, `z.record(z.string(), …)`) and Schemars (`(u8, String)`,
`BTreeMap<String, u8>`) must each lower to. Both native implementations judge the
values independently. Its compatibility pairs live in
`contract-compatibility.json`.

`rust-authoring.json` pins what Zod and Schemars must each author to the same
Program v1 contract. `patterns` holds the exact `pattern` strings Zod 4 emits
for `z.uuid()` and `z.email()`: TypeScript keeps them and drops `format`, Rust
rewrites Schemars' `format: "uuid"` / `"email"` to them. `parity` pairs a Zod
schema with a Rust type under one `name` and records the contract plus its
digest (`sha256:` of the UTF-8 canonical JSON). `declaredErrors` pairs a Zod `errors: { code: schema }` declaration with the
Rust `#[derive(Fault)]` enum (`tag = "code", content = "details"`) that must
declare the identical `errorSchema`, with its digest: code-ordered closed
`oneOf` branches, a bare object for a single code, and `details: null` for a
Rust unit variant (TypeScript's `z.null()`). `rejected` names the authoring
shapes each language refuses: open objects, open enum variants, and flattened
structs. Closed objects are required in both languages, so extra keys never
survive one side's parser and fail the other's contract.

`plugin-import-abi.json` establishes the exact host-import signature law for
Plugin guests. Each provided import is `(string) -> result<string, string>`; a
component declaring any other parameters or result is refused before guest code
runs, so a core start function cannot enter the host through it. A refusal is
`not-started` with zero host entries. A matching import that is entered and then
fails (startup or invocation) is `unknown`, because the effect may have
happened; a matching import that returns is `completed`. The fixtures are real
components built from checked-in WAT in `tests/fixtures/plugin-import-abi/`
(`just fixtures-verify` reproduces them). Both native hosts consume the file
independently.

The same file pins three more Plugin laws. Component-model async is off in both
hosts: the `async-profile` component is refused with `not-started` and zero host
entries. A matching signature is admitted however its types are aliased (the
`alias-*-admitted` fixtures), and the same signature mismatch behind an alias is
refused, so the hosts admit exactly the same components. The `hostcallCopyBudget`
section fixes the host-call copy budget: UTF-8 bytes of requests plus replies
(including declared errors) per invocation, equality allowed, a request over
budget never reaching the host, a reply over budget withheld after the host ran,
both `unknown`.

`declared-errors.json` establishes that a contract's `errorSchema` validates the
complete `{ code, details }` value, never `details` alone: each code selects its
own details schema, so an unknown code, a code paired with another code's
details, missing or extra fields, and wrong detail types are all refused.
`schema` is the reviewed `oneOf` that TypeScript builds from
`errors: { code: schema }` and that Rust's `DeclaredErrorCodec::declared_schema`
must compile to for the same declaration. TypeScript's checked Handoff and
`ProjectionClient`, and Rust's `RemoteCaller`, each judge every case; an
accepted case reaches the caller as the declared error, a refused one is an
`unknown` outcome. The vector is reviewed evidence, never generated from either
implementation.

`schema-values.json` establishes portable value equality for `const`, `enum`,
and `uniqueItems`. JSON numbers compare by finite binary64 value regardless of
integer, decimal, or exponent spelling (`1`, `1.0`, `125e-2`), and `-0` equals
`0`; JSON types, object members, and array order remain distinct. Cases hold
the schema and the instance as JSON text (`schemaJson`, `valueJson`) because a
parsed spelling is exactly what differs between implementations; TypeScript
cannot distinguish `1` from `1.0` after parsing, so Rust must not either.
`refusedSchemas` lists `enum` declarations whose entries are numerically
duplicate and must fail schema compilation in both languages.

`mcp-envelope.json` records the model-facing tool result envelope that the
TypeScript MCP and WebMCP adapters and the Rust MCP server emit for one checked
Handoff outcome. A result carries the outcome unchanged as `structuredContent`,
flags `isError` exactly as listed, and opens `content[0].text` with the listed
summary before the outcome's JSON. The kinds a model must tell apart are
success, declared-error, denied, invalid, proposed, and uncertain, with failed
covering faults proven not to have started. `proposed` says the effect has not
run and awaits host review; `uncertain` says the effect may have run, forbids a
repeat, and names the installation to check with. Both implementations consume
the cases independently; neither generates them.
