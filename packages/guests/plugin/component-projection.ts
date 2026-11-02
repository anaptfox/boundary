// Loaded by plugin workers as plain TypeScript: relative imports carry extensions
// and nothing here may depend on SDK internals.
import { atom, descriptor, fail, identifier, name, optionalDescriptor, type Atom, type Form } from "./component-wat.ts";

type Kind = "type" | "func" | "instance" | "component" | "value" |
  "core-type" | "core-func" | "core-instance" | "core-module" | "core-table" |
  "core-memory" | "core-global" | "core-tag";
/** `repr` is a scope-independent spelling of a value or function type, so a signature survives every alias. */
type Entry = Readonly<{ kind: Kind; definition?: string; repr?: string; shape?: Scope; source?: Entry; type?: Entry }>;
type Space = { entries: Entry[]; names: Map<string, number> };

/** Each component/type has its own indices; an instance export bag does not. */
class Scope {
  readonly spaces = new Map<Kind, Space>();
  readonly imports = new Map<string, Entry>();
  readonly exports = new Map<string, Entry>();
  readonly parent: Scope | undefined;
  readonly id: string | undefined;
  readonly typeContext: boolean;
  // Explicit fields: plugin workers load this file with Node's strip-only TypeScript.
  constructor(parent?: Scope, id?: string, typeContext = false) {
    this.parent = parent;
    this.id = id;
    this.typeContext = typeContext;
  }

  add(kind: Kind, form: Form, entry: Entry): Entry {
    if (entry.kind !== kind) fail(`expected ${kind}, received ${entry.kind}`);
    const space: Space = this.spaces.get(kind) ?? { entries: [], names: new Map() };
    const id = identifier(form);
    if (id !== undefined) {
      if (space.names.has(id)) fail(`duplicate printed ${kind} identifier ${id}`);
      space.names.set(id, space.entries.length);
    }
    space.entries.push(entry);
    this.spaces.set(kind, space);
    return entry;
  }

  get(kind: Kind, reference: string | undefined): Entry {
    const space = this.spaces.get(kind);
    const index = reference?.startsWith("$") ? space?.names.get(reference)
      : reference !== undefined && /^\d+$/.test(reference) ? Number(reference) : undefined;
    const entry = index === undefined ? undefined : space?.entries[index];
    return entry ?? fail(`unresolved ${kind} ${String(reference)}`);
  }

  outer(reference: string | undefined): Scope {
    if (reference?.startsWith("$")) {
      // oxlint-disable-next-line typescript/no-this-alias -- walks the parent chain starting at this scope
      for (let scope: Scope | undefined = this; scope !== undefined; scope = scope.parent) {
        if (scope.id === reference) return scope;
      }
    } else if (reference !== undefined && /^\d+$/.test(reference)) {
      // oxlint-disable-next-line typescript/no-this-alias -- walks the parent chain starting at this scope
      let scope: Scope | undefined = this;
      for (let count = Number(reference); count > 0 && scope !== undefined; count--) scope = scope.parent;
      if (scope !== undefined) return scope;
    }
    return fail(`unresolved outer scope ${String(reference)}`);
  }
}

const kinds = new Set<string>(["type", "func", "instance", "component", "value", "core-type",
  "core-func", "core-instance", "core-module", "core-table", "core-memory", "core-global", "core-tag"]);

function isKind(value: string | undefined): value is Kind {
  return value !== undefined && kinds.has(value);
}

function kind(form: Form, core = false): Kind {
  const first = atom(form[0]);
  const value = first === "core" ? `core-${atom(form[1])}` : core ? `core-${first}` : first;
  if (!isKind(value)) fail(`unsupported printed entity kind ${String(value)}`);
  return value;
}

function reference(form: Form): string | undefined {
  return form.slice(atom(form[0]) === "core" ? 2 : 1).map(atom)
    .find((value) => value !== undefined);
}

function put(map: Map<string, Entry>, key: string, entry: Entry): void {
  if (map.has(key)) fail(`duplicate printed import or export ${key}`);
  map.set(key, entry);
}

function shape(entry: Entry, expected: string): Scope {
  if (entry.definition !== expected || entry.shape === undefined) fail(`expected ${expected} type shape`);
  return entry.shape;
}

function member(instance: Entry, key: string, expected: Kind): Entry {
  const entry = instance.shape?.exports.get(key);
  if (entry === undefined) fail(`instance has no export ${key}`);
  if (entry.kind !== expected) fail(`instance export ${key} is ${entry.kind}, expected ${expected}`);
  return entry;
}

/** A descriptor creates a typed entity rather than referencing a runtime index. */
function typed(scope: Scope, form: Form): Entry {
  const entityKind = kind(form);
  const body = optionalDescriptor(form);
  if (entityKind === "type") {
    if (body === undefined) fail("missing imported or exported type bound");
    if (atom(body[0]) === "eq") {
      const source = scope.get("type", atom(body[1]));
      // A type bound creates a distinct type identity. Aliasing that identity
      // later must still follow instantiation substitutions for its source.
      return { ...source, source };
    }
    if (atom(body[0]) === "sub" && atom(body[1]) === "resource") return { kind: "type", definition: "resource" };
    return fail("unsupported imported or exported type bound");
  }
  if (entityKind === "value") return { kind: entityKind };
  if (body === undefined || atom(body[0]) !== "type") fail(`missing ${entityKind} type reference`);
  const type = scope.get(entityKind === "core-module" ? "core-type" : "type", atom(body[1]));
  const expected = entityKind === "core-module" ? "module" : entityKind;
  if (type.definition !== expected) fail(`expected ${expected} type, received ${String(type.definition)}`);
  return { kind: entityKind, definition: expected, shape: type.shape, type };
}

/**
 * Spell a type with every reference resolved. Parameter and result labels are
 * not part of a function's type; record, variant and flag labels are.
 */
function describe(scope: Scope, node: Atom | Form): string {
  if (!Array.isArray(node)) {
    const text = atom(node);
    if (text === undefined) return JSON.stringify((node as Atom).value);
    if (text.startsWith("$") || /^\d+$/.test(text)) {
      try {
        const entry = scope.get("type", text);
        return entry.repr ?? `<${entry.definition ?? "type"}>`;
      } catch {
        return text;
      }
    }
    return text;
  }
  const head = atom(node[0]) ?? "?";
  const unlabelled = head === "param" || head === "result";
  const parts = node.slice(1)
    .filter((item) => !(unlabelled && !Array.isArray(item) && item.quoted))
    .map((item) => describe(scope, item));
  return `${head}(${parts.join(",")})`;
}

function typeDefinition(scope: Scope, form: Form, core = false): Entry {
  const body = optionalDescriptor(form);
  const definition = body === undefined ? form.slice(core ? 2 : 1).map(atom)
    .find((value) => value !== undefined && !value.startsWith("$")) : atom(body[0]);
  const entityKind = core ? "core-type" : "type";
  if (body !== undefined && (definition === "instance" || definition === "component")) {
    // Printer type scopes have no component scope name. The enclosing type's
    // identifier belongs to its parent's type indices, not outer-scope lookup.
    return { kind: entityKind, definition, shape: project(body, new Scope(scope, undefined, true)) };
  }
  if (body !== undefined && core && definition === "module") {
    return { kind: entityKind, definition, shape: coreModule(body, new Scope(scope, undefined, true)) };
  }
  if (core) return { kind: entityKind, definition };
  return { kind: entityKind, definition, repr: body === undefined ? definition : describe(scope, body) };
}

function alias(scope: Scope, form: Form, core = false): void {
  const target = descriptor(form);
  const targetKind = kind(target, core);
  let entry: Entry;
  if (atom(form[1]) === "outer") {
    if (!["type", "component", "core-type", "core-module"].includes(targetKind)) fail("invalid outer alias kind");
    const outer = scope.outer(atom(form[2]));
    entry = outer.get(targetKind, atom(form[3]));
  } else if (atom(form[1]) === "export") {
    if (!["type", "func", "instance", "component", "value", "core-module"].includes(targetKind)) fail("invalid instance alias kind");
    entry = member(scope.get("instance", atom(form[2])), name(form), targetKind);
  } else if (atom(form[1]) === "core" && atom(form[2]) === "export") {
    if (!["core-func", "core-table", "core-memory", "core-global", "core-tag"].includes(targetKind)) fail("invalid core instance alias kind");
    entry = member(scope.get("core-instance", atom(form[3])), name(form), targetKind);
  } else return fail("unsupported printed alias");
  scope.add(targetKind, target, entry);
}

function coreTypes(scope: Scope, form: Form): void {
  for (const item of form) {
    if (!Array.isArray(item) || atom(item[0]) !== "type") continue;
    scope.add("core-type", item, typeDefinition(scope, item, true));
  }
}

/** Match imported type identities to the actual argument's exported types. */
function substitutions(expected: Entry, actual: Entry, replacements: Map<Entry, Entry>): void {
  if (expected.kind !== actual.kind) fail(`instantiation argument is ${actual.kind}, expected ${expected.kind}`);
  if (expected.kind === "type") replacements.set(expected, actual);
  // Only instance parameters register their exported type identities. Types
  // substitute as a whole; a component argument retains its declared shape.
  if (expected.kind === "instance" && expected.shape !== undefined) {
    if (actual.shape === undefined) fail("unresolved instantiation argument shape");
    for (const [key, child] of expected.shape.exports) {
      const supplied = actual.shape.exports.get(key) ?? fail(`instantiation argument has no export ${key}`);
      substitutions(child, supplied, replacements);
    }
  }
}

/** Rebuild exported shapes under the instantiation's type-identity substitution. */
function substituted(definition: Scope, replacements: Map<Entry, Entry>): Scope {
  const memo = new Map<Entry, Entry>();
  const resolve = (entry: Entry): Entry => {
    const replacement = replacements.get(entry);
    if (replacement !== undefined) return replacement;
    const cached = memo.get(entry);
    if (cached !== undefined) return cached;
    const source = entry.source === undefined ? undefined : resolve(entry.source);
    const type = entry.type === undefined ? undefined : resolve(entry.type);
    const originalShape = type?.shape ?? source?.shape ?? entry.shape;
    const result: Entry = {
      kind: entry.kind,
      definition: type?.definition ?? source?.definition ?? entry.definition,
      repr: type?.repr ?? source?.repr ?? entry.repr,
      source,
      type,
      shape: originalShape === undefined ? undefined : transform(originalShape),
    };
    memo.set(entry, result);
    return result;
  };
  const transform = (original: Scope): Scope => {
    const result = new Scope();
    for (const [key, entry] of original.exports) result.exports.set(key, resolve(entry));
    for (const [key, entry] of original.imports) result.imports.set(key, resolve(entry));
    return result;
  };
  return transform(definition);
}

function instance(scope: Scope, form: Form, core = false): Entry {
  const entityKind = core ? "core-instance" : "instance";
  const statements = form.filter((item): item is Form => Array.isArray(item));
  const instantiate = statements.find((item) => atom(item[0]) === "instantiate");
  if (instantiate !== undefined) {
    if (statements.length !== 1) fail("ambiguous printed instance definition");
    const component = scope.get(core ? "core-module" : "component", atom(instantiate[1]));
    const definition = component.shape ?? fail("unresolved instantiated component or module shape");
    const args = new Map<string, Entry>();
    for (const item of instantiate.slice(2)) {
      if (!Array.isArray(item) || atom(item[0]) !== "with") fail("unsupported instantiation argument");
      const target = descriptor(item);
      const entity = scope.get(kind(target, core), reference(target));
      put(args, name(item), entity);
    }
    const replacements = new Map<Entry, Entry>();
    for (const [key, expected] of definition.imports) {
      const actual = args.get(key);
      if (actual === undefined || actual.kind !== expected.kind) fail(`unresolved instantiation argument ${key}`);
      substitutions(expected, actual, replacements);
    }
    for (const key of args.keys()) {
      if (!definition.imports.has(key)) fail(`unknown instantiation argument ${key}`);
    }
    // Imported eq types may be supplied with wider instance types. Follow the
    // actual identities, including their extra members, before reading aliases.
    return { kind: entityKind, shape: substituted(definition, replacements) };
  }
  const definition = new Scope();
  for (const item of statements) {
    if (atom(item[0]) !== "export") fail("unsupported printed instance definition");
    const target = descriptor(item);
    put(definition.exports, name(item), scope.get(kind(target, core), reference(target)));
  }
  return { kind: entityKind, shape: definition };
}

/** Core code is opaque; only its static export bag is needed by core aliases. */
function coreModule(form: Form, scope: Scope): Scope {
  const exports: Form[] = [];
  for (const item of form.slice(1)) {
    if (!Array.isArray(item)) continue;
    const head = atom(item[0]);
    if (head?.startsWith("@") || head === "data" || head === "elem" || head === "start") continue;
    if (head === "import") {
      const target = descriptor(item);
      const entityKind = kind(target, true);
      const entity = { kind: entityKind };
      scope.add(entityKind, target, entity);
      // Core module imports have module AND member names. Instantiation supplies
      // one core instance per module name, not one argument per imported member.
      const moduleName = name(item);
      if (!scope.imports.has(moduleName)) scope.imports.set(moduleName, { kind: "core-instance" });
    } else if (head === "export") {
      // Core exports precede function bodies in binary section order, so their
      // references can point forward within this opaque module.
      exports.push(item);
    } else if (head === "alias") alias(scope, item, true);
    else if (head === "rec") coreTypes(scope, item);
    else {
      const entityKind = kind(item, true);
      scope.add(entityKind, item, { kind: entityKind });
    }
  }
  for (const item of exports) {
    const target = descriptor(item);
    const entityKind = kind(target, true);
    const entity = scope.typeContext ? { kind: entityKind } : scope.get(entityKind, reference(target));
    put(scope.exports, name(item), entity);
  }
  return scope;
}

function project(form: Form, scope: Scope): Scope {
  for (const item of form.slice(1)) {
    if (!Array.isArray(item)) continue;
    const head = atom(item[0]);
    if (head?.startsWith("@") || head === "start") continue;
    if (head === "type") scope.add("type", item, typeDefinition(scope, item));
    else if (head === "alias") alias(scope, item);
    else if (head === "import") {
      const target = descriptor(item);
      const entry = typed(scope, target);
      scope.add(entry.kind, target, entry);
      put(scope.imports, name(item), entry);
    } else if (head === "export") {
      const targets = item.filter((entry): entry is Form => Array.isArray(entry) && !atom(entry[0])?.startsWith("@"));
      const target = targets[0] ?? fail("missing printed export descriptor");
      // An export ascription changes its static shape; its single newly added
      // entity slot must use that shape, never the original entity's superset.
      if (targets.length > 2) fail("ambiguous printed export descriptors");
      let entry = scope.typeContext ? typed(scope, target) : scope.get(kind(target), reference(target));
      const ascription = targets[1];
      if (ascription !== undefined) {
        if (scope.typeContext) fail("unexpected type-context export ascription");
        const ascribed = typed(scope, ascription);
        if (ascribed.kind !== entry.kind) fail("export ascription kind mismatch");
        entry = ascribed;
      }
      const exported = !scope.typeContext && entry.kind === "type" ? { ...entry, source: entry } : entry;
      scope.add(exported.kind, item, exported);
      put(scope.exports, name(item), exported);
    } else if (head === "component") {
      const definition = project(item, new Scope(scope, identifier(item)));
      scope.add("component", item, { kind: "component", shape: definition });
    } else if (head === "instance") scope.add("instance", item, instance(scope, item));
    else if (head === "func" || head === "value") scope.add(kind(item), item, { kind: kind(item) });
    else if (head === "core") {
      if (atom(item[1]) === "rec") { coreTypes(scope, item); continue; }
      const entityKind = kind(item);
      if (entityKind === "core-type") scope.add(entityKind, item, typeDefinition(scope, item, true));
      else if (entityKind === "core-module") {
        scope.add(entityKind, item, { kind: entityKind, shape: coreModule(item, new Scope(scope, identifier(item))) });
      } else if (entityKind === "core-instance") scope.add(entityKind, item, instance(scope, item, true));
      else scope.add(entityKind, item, { kind: entityKind });
    } else fail(`unsupported printed component declaration ${String(head)}`);
  }
  return scope;
}

/** One name a component imports at its root, or one member of an instance it imports. */
export type ImportedMember = Readonly<{
  /** The imported instance, or undefined for a root import itself. */
  instance: string | undefined;
  name: string;
  kind: Kind;
  /** For a function, its declared type resolved through every alias, instantiation and ascription. */
  signature: string | undefined;
}>;

/** Only the enclosing component's imports can require authority from its host. */
export function importedMembers(root: Form): ImportedMember[] {
  const scope = project(root, new Scope(undefined, identifier(root)));
  const members: ImportedMember[] = [];
  for (const [key, entry] of scope.imports) {
    if (entry.kind === "instance") {
      for (const [memberName, member] of shape(entry, "instance").exports) {
        members.push({ instance: key, name: memberName, kind: member.kind,
          signature: member.kind === "func" ? member.type?.repr : undefined });
      }
    } else {
      members.push({ instance: undefined, name: key, kind: entry.kind,
        signature: entry.kind === "func" ? entry.type?.repr : undefined });
    }
  }
  return members;
}
