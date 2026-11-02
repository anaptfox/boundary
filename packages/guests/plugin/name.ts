/**
 * Interaction identifier to WIT identifier derivation.
 *
 * Interaction ids follow the Program v1 token grammar,
 * `[A-Za-z0-9][A-Za-z0-9._~-]{0,127}`. WIT identifiers are lowercase kebab
 * segments, `[a-z][a-z0-9]*(-[a-z0-9]+)*`, and a small keyword set is
 * reserved. The two grammars do not correspond, so this module derives a name
 * and reports an exact failure rather than guessing.
 *
 * Derivation never invents authority or identity: the interaction id remains
 * the contract identity, and the derived name is only the WIT spelling of it.
 * The projector records both, so a reader can always recover the id.
 *
 * This is a from-scratch TypeScript port of the algorithm in
 * `crates/boundary-plugin/src/name.rs`. It must derive byte-identical WIT
 * identifiers for the same interaction id; the shared conformance vector is the
 * check, not this comment.
 */
import { BoundaryErrorBase } from "@foxworth/boundary/program";

/** Reserved WIT words that cannot be used as an identifier. */
const WIT_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

/** Why an interaction id has no valid WIT spelling. */
export type NameDiagnosticCode =
  | "EMPTY"
  | "SEGMENT_START"
  | "SEGMENT_CHARACTER"
  | "RESERVED";

/** One interaction id that cannot be spelled as a WIT identifier. */
export class NameError extends BoundaryErrorBase {
  declare readonly code: NameDiagnosticCode;
  /** The interaction id that failed. */
  readonly interactionId: string;
  /** The derived name at the point of failure, when one existed. */
  readonly derived?: string;
  /** The offending segment, for `SEGMENT_START` and `SEGMENT_CHARACTER`. */
  readonly segment?: string;

  constructor(
    code: NameDiagnosticCode,
    interactionId: string,
    message: string,
    options: Readonly<{ derived?: string; segment?: string }> = {},
  ) {
    super(code, `${interactionId}.witIdentifier`, message);
    this.name = "NameError";
    this.interactionId = interactionId;
    if (options.derived !== undefined) this.derived = options.derived;
    if (options.segment !== undefined) this.segment = options.segment;
  }
}

/** The outcome of deriving a WIT identifier: success or a structured failure. */
export type NameResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: NameError };

function isAsciiLower(character: string): boolean {
  return character >= "a" && character <= "z";
}

function isAsciiUpper(character: string): boolean {
  return character >= "A" && character <= "Z";
}

function isAsciiDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

const SEPARATORS: ReadonlySet<string> = new Set([".", "_", "~", "-"]);

/**
 * Splits an interaction id into lowercase segments.
 *
 * Separators are `.`, `_`, `~`, and `-`. A lowercase-to-uppercase transition
 * also starts a new segment, so `makeThumbnail` becomes `make` and
 * `thumbnail`. A digit never starts a new segment, so `todos.v2` keeps `v2`
 * intact rather than producing an invalid leading-digit segment.
 */
function segments(interactionId: string): readonly string[] {
  const out: string[] = [];
  let current = "";
  let previousLowerOrDigit = false;

  for (const character of interactionId) {
    if (SEPARATORS.has(character)) {
      if (current !== "") {
        out.push(current);
        current = "";
      }
      previousLowerOrDigit = false;
      continue;
    }

    if (isAsciiUpper(character) && previousLowerOrDigit && current !== "") {
      out.push(current);
      current = "";
    }

    previousLowerOrDigit = isAsciiLower(character) || isAsciiDigit(character);
    current += character.toLowerCase();
  }

  if (current !== "") out.push(current);
  return out;
}

/**
 * Derives the WIT identifier for one interaction id.
 *
 * Returns a structured {@link NameError} rather than throwing, so a caller
 * that must report every failing id (never just the first) can collect
 * results across a whole Program before deciding what to do.
 */
export function witIdentifier(interactionId: string): NameResult {
  const parts = segments(interactionId);
  if (parts.length === 0) {
    return {
      ok: false,
      error: new NameError(
        "EMPTY",
        interactionId,
        "derives no WIT identifier segments",
      ),
    };
  }

  for (const segment of parts) {
    const first = segment.charAt(0);
    if (!isAsciiLower(first)) {
      return {
        ok: false,
        error: new NameError(
          "SEGMENT_START",
          interactionId,
          `segment ${JSON.stringify(segment)} must begin with an ASCII lowercase letter`,
          { derived: parts.join("-"), segment },
        ),
      };
    }
    for (let index = 1; index < segment.length; index += 1) {
      const character = segment.charAt(index);
      if (!isAsciiLower(character) && !isAsciiDigit(character)) {
        return {
          ok: false,
          error: new NameError(
            "SEGMENT_CHARACTER",
            interactionId,
            `segment ${JSON.stringify(segment)} must contain only ASCII lowercase letters and digits`,
            { derived: parts.join("-"), segment },
          ),
        };
      }
    }
  }

  const derived = parts.join("-");
  if (WIT_KEYWORDS.has(derived)) {
    return {
      ok: false,
      error: new NameError(
        "RESERVED",
        interactionId,
        "derives a reserved WIT keyword",
        { derived },
      ),
    };
  }
  return { ok: true, value: derived };
}
