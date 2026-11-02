export type Atom = Readonly<{ value: string; quoted: boolean; bytes?: Uint8Array }>;
export type Form = (Atom | Form)[];

export function fail(message: string): never {
  throw new Error(`cannot inspect component imports: ${message}`);
}

/** Tokenize the printer's S-expressions, without interpreting Wasm grammar. */
export function forms(wat: string): Form {
  const roots: Form = [];
  const stack = [roots];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let cursor = 0;
  const quoted = (): Atom => {
    cursor++;
    const bytes: number[] = [];
    while (cursor < wat.length) {
      const character = wat[cursor++]!;
      if (character === '"') {
        const raw = new Uint8Array(bytes);
        // Core data literals can contain arbitrary bytes. Decode authority
        // names strictly only when selecting their import/export nodes.
        return { value: decoder.decode(raw), quoted: true, bytes: raw };
      }
      if (character !== "\\") {
        const point = character.codePointAt(0)!;
        const text = point >= 0xd800 && point <= 0xdbff
          ? character + wat[cursor++]!
          : character;
        bytes.push(...encoder.encode(text));
        continue;
      }
      const escape = wat[cursor++]!;
      const hex = escape + (wat[cursor] ?? "");
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16)); cursor++;
      } else if (escape === "u" && wat[cursor] === "{") {
        const end = wat.indexOf("}", cursor);
        const digits = wat.slice(cursor + 1, end);
        const point = Number.parseInt(digits, 16);
        if (end < 0 || !/^[0-9a-fA-F]+$/.test(digits) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
          fail("invalid printed Unicode escape");
        }
        bytes.push(...encoder.encode(String.fromCodePoint(point)));
        cursor = end + 1;
      } else if (escape === '"' || escape === "\\") bytes.push(escape.charCodeAt(0));
      else if (escape === "t") bytes.push(9);
      else if (escape === "n") bytes.push(10);
      else if (escape === "r") bytes.push(13);
      else fail("unsupported printed string escape");
    }
    return fail("unterminated printed string");
  };
  while (cursor < wat.length) {
    const character = wat[cursor]!;
    if (/\s/.test(character)) { cursor++; continue; }
    if (wat.startsWith(";;", cursor)) {
      const newline = wat.indexOf("\n", cursor);
      cursor = newline < 0 ? wat.length : newline + 1;
      continue;
    }
    if (wat.startsWith("(;", cursor)) {
      cursor += 2;
      let depth = 1;
      while (cursor < wat.length && depth > 0) {
        if (wat.startsWith("(;", cursor)) { depth++; cursor += 2; }
        else if (wat.startsWith(";)", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth !== 0) fail("unterminated printed comment");
      continue;
    }
    const current = stack[stack.length - 1]!;
    if (character === "(") {
      const form: Form = [];
      current.push(form); stack.push(form); cursor++;
    } else if (character === ")") {
      if (stack.length === 1) fail("unmatched printed parenthesis");
      stack.pop(); cursor++;
    } else if (character === '"') {
      current.push(quoted());
    } else if (wat.startsWith('$"', cursor)) {
      cursor++;
      const id = quoted();
      current.push({ value: `$${new TextDecoder("utf-8", { fatal: true }).decode(id.bytes)}`, quoted: false });
    } else {
      const start = cursor;
      while (cursor < wat.length && !/[\s()]/.test(wat[cursor]!)) cursor++;
      current.push({ value: wat.slice(start, cursor), quoted: false });
    }
  }
  if (stack.length !== 1) fail("unclosed printed parenthesis");
  const root = roots[0];
  if (roots.length !== 1 || !Array.isArray(root) || atom(root[0]) !== "component") {
    fail("expected a component binary");
  }
  return root;
}

export function atom(value: Atom | Form | undefined): string | undefined {
  return value !== undefined && !Array.isArray(value) && !value.quoted ? value.value : undefined;
}

export function name(form: Form): string {
  const value = form.find((item): item is Atom => !Array.isArray(item) && item.quoted);
  if (value === undefined) fail("missing printed import or export name");
  return new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
}

export function optionalDescriptor(form: Form): Form | undefined {
  const definitions = form.filter((item): item is Form => Array.isArray(item) && !atom(item[0])?.startsWith("@"));
  if (definitions.length > 1) fail("ambiguous printed type or import descriptor");
  return definitions[0];
}

export function descriptor(form: Form): Form {
  return optionalDescriptor(form) ?? fail("missing printed type or import descriptor");
}

/**
 * A declaration's own identifier is the token directly after its keyword(s).
 * Later `$` atoms in the same form belong to other declarations: an unnamed
 * core function body that executes `call $images` would otherwise be read as
 * a second declaration named `$images`.
 */
export function identifier(form: Form): string | undefined {
  const candidate = atom(form[atom(form[0]) === "core" ? 2 : 1]);
  return candidate?.startsWith("$") ? candidate : undefined;
}
