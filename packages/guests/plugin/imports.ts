/**
 * Host-authored host imports and the bind-time subset check.
 *
 * Authority is absence: a guest reaches only the functions the host maps by
 * name. The check does not enforce that a mapped host function honors its
 * declared read or change class.
 */
import { witIdentifier } from "./name";

/** One function a component genuinely imports. */
export type RequiredImport = {
  readonly instance: string | undefined;
  readonly name: string;
};

/** Outcome of checking a component's imports against the host imports. */
export type ImportCheck =
  | { readonly status: "satisfied"; readonly used: readonly string[] }
  | {
      readonly status: "refused";
      readonly unmapped: readonly string[];
      readonly provided: readonly string[];
    };

type CapturedHostImports = Pick<HostImports, "interface" | "witNames" | "check">;

function checkImports(interfaceName: string, provided: readonly string[], required: readonly RequiredImport[]): ImportCheck {
  const names = new Set(provided);
  const used: string[] = [];
  const unmapped: string[] = [];
  for (const imported of required) {
    if (imported.instance === interfaceName && names.has(imported.name)) used.push(imported.name);
    else unmapped.push(qualifiedImport(imported));
  }
  used.sort(); unmapped.sort();
  return unmapped.length === 0 ? { status: "satisfied", used }
    : { status: "refused", unmapped, provided: [...provided] };
}

/** Internal capture: async inspection cannot observe later authority changes. */
export function snapshotHostImports(imports: CapturedHostImports): CapturedHostImports {
  const interfaceName = imports.interface;
  const names = Object.freeze(imports.witNames());
  return Object.freeze({
    interface: interfaceName,
    witNames: () => [...names],
    check: (required: readonly RequiredImport[]) => checkImports(interfaceName, names, required),
  });
}

/** The complete set of imports a host provides one guest. */
export class HostImports {
  readonly interface: string;
  private readonly entries: Map<string, string>;

  constructor(interfaceName: string) {
    this.interface = interfaceName;
    this.entries = new Map();
  }

  /**
   * Provides one footprint under its derived WIT name.
   *
   * Distinct footprints can derive one WIT name (`a.bC` and `a.b-c` both give
   * `a-b-c`). Overwriting the first would leave the host believing it provided
   * two capabilities while a guest reaches whichever was provided last — a
   * read-class footprint replaced by a change-class one, with nothing
   * reported. Mirrors `HostImports::provide` in Rust.
   */
  provide(footprint: string): HostImports {
    const derived = witIdentifier(footprint);
    if (!derived.ok) {
      throw derived.error;
    }
    const claimed = this.entries.get(derived.value);
    if (claimed !== undefined && claimed !== footprint) {
      throw new Error(
        `footprint ${JSON.stringify(footprint)} derives the WIT name ${JSON.stringify(derived.value)}, already claimed by ${JSON.stringify(claimed)}`,
      );
    }
    this.entries.set(derived.value, footprint);
    return this;
  }

  contains(witName: string): boolean {
    return this.entries.has(witName);
  }

  witNames(): string[] {
    return [...this.entries.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }

  check(required: readonly RequiredImport[]): ImportCheck {
    return checkImports(this.interface, this.witNames(), required);
  }
}

export function qualifiedImport(imported: RequiredImport): string {
  return imported.instance === undefined
    ? imported.name
    : `${imported.instance}#${imported.name}`;
}
