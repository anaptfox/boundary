---
title: "Portable schemas"
description: "One fail-closed schema meaning for identity, validation, and generated interfaces."
---

# Portable schemas

Why does Boundary care so much about schemas? Because a local Caller, an HTTP Handoff, an MCP tool definition, and a native Rust host must all give the **exact same yes/no answer** for every value. If one side silently strips unknown keys or runs a hidden transform, your contract drifts.

Boundary therefore uses **one fail-closed portable JSON Schema profile** for identity, validation, and generated interfaces. You can author schemas in three ways—and all three compile to identical, content-addressed contracts:

1. **Built-in `b.*`** (zero dependencies, strict by construction)
2. **Zod** (`z.strictObject(...)`, optional peer dependency)
3. **Literal `portableSchema(...)`** or Rust `#[derive(JsonSchema)]`

## 1. Zero-dependency `b.*` schemas (recommended default)

`@foxworth/boundary` (and `@foxworth/boundary/program`) ships a built-in builder whose objects are strict (`additionalProperties: false`) by construction:

```ts
import { b, compileInteractions, defineInteraction, type InferSchema } from "@foxworth/boundary";

const NewTodo = b.object({
  title: b.string({ minLength: 1 }),
  priority: b.optional(b.enum(["low", "high"])),
});
const Todo = b.object({
  id: b.integer(),
  title: b.string(),
});
type TodoValue = InferSchema<typeof Todo>;

export const interactions = {
  create: defineInteraction({
    id: "todos.create",
    input: NewTodo,
    output: Todo,
    errors: {
      alreadyExists: b.object({ title: b.string() }),
    },
    reads: ["todos"],
    changes: ["todos"],
  }),
} as const;

const compiled = compileInteractions(interactions);
```

`b.*` supports `string`, `number`, `integer`, `boolean`, `null`, `literal`, `enum`, `array`, `tuple`, `object`, `optional`, `nullable`, `record`, `union`, `discriminatedUnion`, and `json`. Compilation makes the assertion-bearing contract canonical; documentation annotations (`summary`, `description`) never change contract identity.

## 2. Use Zod directly (optional peer)

```ts
const NewTodo = z.strictObject({ title: z.string().min(1) });
const Todo = z.strictObject({ id: z.number().int(), title: z.string() });
```

`defineInteraction` accepts Zod schemas directly. The current
`@foxworth/boundary/program/zod` Adapter produces:

- assertion-bearing JSON Schema for interaction identity and validation;
- annotation-only data for documentation and presentation;
- one bounded JSON Schema contract used at every checked seam.

```ts
import { zodSchemaAdapter } from "@foxworth/boundary/program/zod";

const interactions = {
  create: defineInteraction({
    id: "todos.create",
    input: NewTodo,
    output: Todo,
  }),
} as const;

const compiled = compileInteractions(interactions, {
  schemas: [zodSchemaAdapter],
});
```

The explicit option makes adapter selection visible; omitting it uses the
built-in portable and Zod adapters. A framework lowering Adapter may compile
its native schema declarations through the same Host seam.

Nullable primitives work through the built-in adapter. Zod's generated
`{ type: ["string", "null"] }` is lowered to
`{ anyOf: [{ type: "string" }, { type: "null" }] }`. Sibling assertions and the
separate annotation data are retained. Bounded nullable strings, numbers and
arrays retain their bounds. Raw type arrays remain outside the portable profile;
this is an authoring adaptation, not a new schema language.

Changing a declaration from `z.string()` to `z.string().nullable()` changes its
contract identity deliberately. For input contracts, an existing string caller
can be served by the nullable implementation, while the reverse direction
cannot accept every promised input. Inspect `contractChanges` and the new digest
before migrating pinned callers. The reviewed
[`nullable-authoring.json`](../../tests/conformance/v1/nullable-authoring.json)
contains independently computed old/new identity pins and portable value laws.

### Objects are strict

Every object in a Zod interaction schema must be strict. Use `z.strictObject()`,
`.strict()`, or an explicit `.catchall(schema)`:

```ts
const Todo = z.strictObject({ id: z.number().int(), title: z.string() });
```

A plain `z.object()` fails compilation. When Zod parses a plain object, it
drops unknown keys. The compiled contract rejects them, so a plain object would
give Zod and the contract different answers. A strict object rejects unknown keys
in both. `z.object({...}).strict()` and `z.strictObject({...})` compile to the
same contract.

This rule applies only to schemas passed to `defineInteraction`. Zod schemas an
application uses for its own parsing, such as a disk file, a database row, or a
model's response, keep whatever object mode suits them.

### What the Zod adapter compiles

Each form below compiles to a contract that accepts exactly the values Zod
accepts:

| Zod | Contract |
| --- | --- |
| `z.string()`, numbers, `z.number().int()`, booleans, `z.null()`, `z.enum()`, `z.literal()` | `type`, bounds, `enum`, `const`. Integers keep their safe-integer bounds. |
| `z.array(item)` with length checks | `items`, `minItems`, `maxItems` |
| `z.strictObject(shape)`, `.optional()` fields | closed `properties` with `required` |
| `.nullable()` | `anyOf` with `null` |
| `z.union([...])` | `anyOf` |
| `z.xor([...])`, `z.discriminatedUnion(key, [...])` | `oneOf`: exactly one branch matches |
| `z.intersection(a, b)` of strict objects with disjoint keys | one closed object |
| `z.tuple([...])`, optionally `.rest(item)` | `prefixItems`, `items`, arity bounds |
| `z.record(z.string(), value)` | `propertyNames` and `additionalProperties` |
| `z.uuid()`, `z.email()` | Zod's own `pattern`. The `format` keyword is dropped, because Zod checks exactly that pattern. |
| `.regex(/.../u)` | `pattern`. The regular expression must use exactly the `u` flag. |

Intersections whose halves share a key, or that aren't both strict objects,
still fail. So do records with enum, literal or number keys, and string formats
without a pattern, such as `z.url()`.

`zod` (`^4.6.5`) is an **optional** peer dependency of `@foxworth/boundary`. Install it only if you author contracts with Zod or import `@foxworth/boundary/program/zod`; packages using `b.*` or `portableSchema` need zero schema dependencies.

### Rust authoring

Rust types compile through Schemars to the same contracts, so a Zod schema and
a Rust type with equal contracts share a digest. The rules mirror Zod's:

- Structs and enums are closed with `#[serde(deny_unknown_fields)]`. On an enum
  the attribute goes on the container, which closes every variant. An open
  object fails lowering and the error names the attribute.
- A `#[serde(flatten)] BTreeMap<String, T>` field is the equivalent of
  `.catchall(T)`.
- `#[serde(flatten)]` of a struct is rejected, because serde cannot close it.
- `Option<T>` is an optional, nullable field, as `.nullish()` is in Zod.
- Tagged enums compile to `oneOf` and `#[serde(untagged)]` enums to `anyOf`.
  Variants and union branches must appear in the same order to share a digest.
- `uuid::Uuid` needs Schemars' `uuid1` feature. A `String` field with
  `#[schemars(email)]` is an email. Both compile to the exact `pattern` that
  `z.uuid()` and `z.email()` emit.
- `JsonCodec` checks every incoming value against the contract before serde
  decodes it.

## Literal portable schemas

An external host that already owns JSON Schema can author it directly:

```ts
import { portableSchema } from "@foxworth/boundary/program";

const NewTodo = portableSchema<Readonly<{ title: string }>>({
  type: "object",
  properties: { title: { type: "string", minLength: 1 } },
  required: ["title"],
  additionalProperties: false,
});
```

`portableSchema<Value>` validates and freezes a schema in the supported profile
while carrying `Value` for TypeScript inference. The generic does not weaken
runtime acceptance.

## Portability fails closed

Boundary rejects behavior that cannot be represented faithfully rather than
publishing a weaker contract. Rejected Zod examples include plain (stripping)
objects, `z.looseObject()`, transforms, defaults, coercion, custom checks,
`multipleOf`, recursive lazy schemas, dates, bigints, `any`, `unknown`, and
unsupported JSON Schema keywords.

Pass the original declarative Zod schema to Boundary before attaching a parser.
`z.withParser()` and `z.compile()` attach a parser fast path without changing
the schema declaration. Boundary rejects those marked schemas, including nested
ones, because the attached parser's equivalence is not established by that
declaration. Hosts can still use a separately optimized schema for their own
work. Property checks introduced by `z.properties()` also remain unsupported
when Zod's generated JSON Schema omits them.

```ts
const unsafe = z.string().transform(value => value.trim());
const unsafeInteraction = defineInteraction({
  id: "text.trim",
  input: unsafe,
  output: z.string(),
});
// compileInteractions({ unsafe: unsafeInteraction }) rejects at compile
```

Runtime values must be portable JSON: null, booleans, finite numbers, strings,
arrays, and plain string-keyed objects. Boundary rejects `undefined`, non-finite
numbers, cycles, accessors, symbols, maps, sets, and class instances.

## Add another schema family

Standard Schema supplies a shared type carrier, not a portable JSON Schema
contract. A Host `SchemaAdapter<Schema>` must both recognize its family and
compile the complete wire contract:

```ts
const adapter: SchemaAdapter<MySchema> = {
  supports(value): value is MySchema {
    return isMySchema(value);
  },
  compile(schema, context) {
    return {
      contract: toCanonicalJsonSchema(schema, context),
      annotations: documentationFor(schema),
    };
  },
};

const interactions = {
  replace: defineInteraction({
    id: "documents.replace",
    input: myInputSchema,
    output: myOutputSchema,
  }),
} as const;

const compiled = compileInteractions(interactions, {
  schemas: [adapter],
});
```

`MySchema` carries its inferred JSON output through its Standard Schema
`~standard.types.output` member. The Host preserves that type in definitions,
implementations, and handles while the adapter supplies runtime meaning.

The generated contract must fully express accepted values. A custom Adapter
cannot add a separate local parser; otherwise local Caller, installed
realization, and remote Handoff could disagree.

Changing an assertion changes interaction and Program identity. Changing only
annotations does not. If a feature cannot be classified faithfully,
compilation rejects it.

See the [Program reference](../reference/program.md) for current schema and
identity details.
