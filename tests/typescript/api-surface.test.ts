import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM check script without declarations
import { createSurfaceReader, normalize } from "../../scripts/check/api-surface.mjs";

function readerFor(files: Record<string, string>) {
  const root = "/virtual";
  const reader = createSurfaceReader((file: string) => {
    const source = files[path.relative(root, file)];
    if (source === undefined) throw new Error(`missing ${file}`);
    return source;
  });
  return (entry: string) => reader.exportsOf(path.join(root, entry)) as Record<string, string>;
}

describe("API surface reader", () => {
  it("reads a class whose generic default contains an object type as one declaration", () => {
    const surface = readerFor({
      "index.d.ts": `export declare class E<V extends Readonly<{ code: string }> = Readonly<{ code: string }>> extends Base {
    readonly value: V;
}
export type After = E;`,
    })("index.d.ts");
    expect(Object.keys(surface).sort()).toEqual(["After", "E"]);
    expect(surface.E).toContain("readonly value:V;");
    expect(surface.After).toBe("type After=E;");
  });

  it("exposes `export * as` as a namespace of the target's exports", () => {
    const surface = readerFor({
      "index.d.ts": `export * as ns from "./inner.js";`,
      "inner.d.ts": `export declare const one: 1;`,
    })("index.d.ts");
    expect(surface.ns).toBe("namespace{one=const one:1;}");
  });

  it("follows named, renamed, type-only and star re-exports to their declarations", () => {
    const surface = readerFor({
      "index.d.ts": `export { a, b as renamed, type T } from "./one.js";\nexport * from "./two.js";`,
      "one.d.ts": `export declare function a(x: number): string;\nexport declare const b: 1;\nexport type T = { x: 1 };`,
      "two.d.ts": `import type { T } from "./one.js";\nexport interface Starred { t: T }`,
    })("index.d.ts");
    expect(Object.keys(surface).sort()).toEqual(["Starred", "T", "a", "renamed"]);
    expect(surface.renamed).toBe("const b:1;");
    expect(surface.Starred).toBe("interface Starred{t:T}");
  });

  it("collects every overload of a function", () => {
    const surface = readerFor({
      "index.d.ts": `export declare function f(x: string): string;\nexport declare function f(x: number): number;`,
    })("index.d.ts");
    expect(surface.f).toContain("f(x:string):string;");
    expect(surface.f).toContain("f(x:number):number;");
  });

  it("reports the same surface when a declaration moves to another file", () => {
    const before = readerFor({
      "index.d.ts": `export { run, type Options } from "./all.js";`,
      "all.d.ts": `export type Options = { retries: number };\nexport declare function run(options: Options): Promise<void>;`,
    })("index.d.ts");
    const after = readerFor({
      "index.d.ts": `export { run } from "./run.js";\nexport { type Options } from "./options.js";`,
      "run.d.ts": `import type { Options } from "./options.js";\nexport declare function run(options: Options): Promise<void>;`,
      "options.d.ts": `export type Options = { retries: number };`,
    })("index.d.ts");
    expect(after).toEqual(before);
  });

  it("reads an inline export and an export list as the same declaration", () => {
    const inline = readerFor({ "index.d.ts": `export declare function run(a: string): void;\nexport interface Options { a: 1 }` })("index.d.ts");
    const listed = readerFor({ "index.d.ts": `declare function run(a: string): void;\ninterface Options { a: 1 }\nexport { run, type Options };` })("index.d.ts");
    expect(listed).toEqual(inline);
  });

  it("ignores bundler import aliases such as Name$1", () => {
    expect(normalize("x: InteractionMode$1")).toBe(normalize("x: InteractionMode"));
    expect(normalize("x: InteractionMode$1")).not.toBe(normalize("x: InteractionModes"));
  });

  it("detects a changed signature", () => {
    const files = (signature: string) => ({ "index.d.ts": `export declare function run(${signature}): void;` });
    expect(readerFor(files("a: string"))("index.d.ts")).not.toEqual(readerFor(files("a: number"))("index.d.ts"));
  });

  it("ignores where a referenced type lives but not what it is called", () => {
    expect(normalize(`x: import("./a.js").T`)).toBe(normalize(`x:  import("../b/c.js").T`));
    expect(normalize(`x: import("./a.js").T`)).not.toBe(normalize(`x: import("./a.js").U`));
  });

  it("marks names it cannot resolve instead of dropping them", () => {
    const surface = readerFor({ "index.d.ts": `export { missing } from "./empty.js";`, "empty.d.ts": `` })("index.d.ts");
    expect(surface.missing).toBe("<unresolved missing>");
  });
});
