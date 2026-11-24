import { compareUtf8, type JsonValue } from "./json";
import { ProgramError } from "./program-error";

const segment = /^[A-Za-z0-9_-]+$/u;
const placeholder = /\{input\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\}/gu;

export function validateFootprint(value: string, path = "footprint"): string {
  const invalid = () => { throw new ProgramError("INVALID_FOOTPRINT", path, "footprint must be trimmed text with valid {input.path} placeholders"); };
  if (typeof value !== "string" || !value || value.trim() !== value) return invalid();
  let cursor = 0;
  for (const match of value.matchAll(placeholder)) {
    const index = match.index!;
    const between = value.slice(cursor, index);
    if (/[{}]/u.test(between)) return invalid();
    const pathValue = match[1]!;
    if (pathValue.split(".").some((part) => !segment.test(part))) return invalid();
    cursor = index + match[0].length;
  }
  if (/[{}]/u.test(value.slice(cursor))) return invalid();
  return value;
}

export function footprintSubsumes(expected: string, offered: string): boolean {
  if (expected === offered) return true;
  if (!expected.includes("{") && offered.startsWith(`${expected}:`)) return offered.length > expected.length + 1;
  if (expected.includes("{") && !/[{}]/u.test(offered)) {
    const pieces: string[] = [];
    let cursor = 0;
    for (const match of expected.matchAll(placeholder)) {
      pieces.push(expected.slice(cursor, match.index!), "([^:]+)");
      cursor = match.index! + match[0].length;
    }
    pieces.push(expected.slice(cursor));
    return new RegExp(`^${pieces.map((part, index) => index % 2 === 1 ? part : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("")}$`, "u").test(offered);
  }
  return false;
}

export function resolveFootprints(templates: readonly string[], input: JsonValue): readonly string[] {
  const resolved = templates.map((template) => {
    validateFootprint(template);
    let failed = false;
    const value = template.replace(placeholder, (_full, dotted: string) => {
      let current: JsonValue | undefined = input;
      for (const part of dotted.split(".")) {
        current = current !== null && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, JsonValue>)[part] : undefined;
      }
      if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") return String(current);
      failed = true;
      return _full;
    });
    if (!failed) return value;
    const coarse = template.split(":", 1)[0]!;
    return coarse && !coarse.includes("{") ? coarse : template;
  });
  return Object.freeze([...new Set(resolved)].sort(compareUtf8));
}

/** Resolve scoped observation fields only when the declaration uses templates. */
export function scopedObservationFootprints(
  reads: readonly string[],
  changes: readonly string[],
  input: JsonValue,
): Readonly<{ scopedReads?: readonly string[]; scopedChanges?: readonly string[] }> {
  return Object.freeze({
    ...(reads.some((value) => value.includes("{")) ? { scopedReads: resolveFootprints(reads, input) } : {}),
    ...(changes.some((value) => value.includes("{")) ? { scopedChanges: resolveFootprints(changes, input) } : {}),
  });
}
