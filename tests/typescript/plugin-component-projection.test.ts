import { describe, expect, it } from "vitest";
import { forms } from "../../packages/guests/plugin/component-wat";
import { importedMembers } from "../../packages/guests/plugin/component-projection";
import { PROFILE_SIGNATURE, validateImportAbi } from "../../packages/guests/plugin/import-abi";

const NAME = "boundary:guest/footprints@1.0.0";

describe("printed identifiers", () => {
  // A core function with no name of its own whose body executes `call $images`
  // has a later `$images` atom. That is a use, never a second declaration.
  it("does not read a name used in an unnamed function body as its identifier", () => {
    const wat = `(component
      (type $host (instance
        (type (;0;) (result string (error string)))
        (type (;1;) (func (param "request" string) (result 0)))
        (export "images" (func (type 1)))))
      (import "${NAME}" (instance $host (type $host)))
      (alias export $host "images" (func $images))
      (core module $m
        (type (;0;) (func (param i32 i32 i32)))
        (import "" "images" (func $images (type 0)))
        (func (;1;) (type 0) call $images))
    )`;
    expect(importedMembers(forms(wat))).toEqual([
      { instance: NAME, name: "images", kind: "func", signature: PROFILE_SIGNATURE },
    ]);
  });
});

describe("signatures resolve through index-only spellings", () => {
  // The same shape as the alias-export fixture, printed without a name section.
  const indexed = (func: string) => `(component
    (type (;0;) (result string (error string)))
    (instance (;0;) (export "reply" (type 0)))
    (alias export 0 "reply" (type (;1;)))
    (type (;2;) (instance
      (alias outer 1 1 (type (;0;)))
      (type (;1;) (func ${func}))
      (export "images" (func (type 1)))))
    (import "${NAME}" (instance (;1;) (type 2))))`;

  it("admits a matching signature behind an exported-type alias", () => {
    expect(() => validateImportAbi(indexed('(param "request" string) (result 0)'))).not.toThrow();
  });

  it("refuses a different parameter list or result behind the same alias", () => {
    for (const func of [
      '(param "request" string) (param "extra" u32) (result 0)',
      '(param "request" u32) (result 0)',
      '(param "request" string)',
      '(param "request" string) (result string)',
    ]) {
      expect(() => validateImportAbi(indexed(func)), func).toThrow(/must be string -> result<string, string>/);
    }
  });

  it("does not let an aliased type that is not result<string, string> pass", () => {
    const wat = indexed('(param "request" string) (result 0)')
      .replace("(result string (error string))", "(result u32 (error string))");
    expect(() => validateImportAbi(wat)).toThrow(/must be string -> result/);
  });
});

describe("synchronous profile", () => {
  const refused = /synchronous Component Model profile/;
  it("refuses async function types and async or callback canon options", () => {
    expect(() => validateImportAbi("(component (type (func async)))")).toThrow(refused);
    expect(() => validateImportAbi("(component (core func (canon lower (func 0) async)))")).toThrow(refused);
    expect(() => validateImportAbi("(component (func (canon lift (core func 0) (callback 1))))")).toThrow(refused);
  });
  it("refuses streams, futures and task or waitable built-ins", () => {
    expect(() => validateImportAbi("(component (type (stream u8)))")).toThrow(refused);
    expect(() => validateImportAbi("(component (type (future)))")).toThrow(refused);
    expect(() => validateImportAbi("(component (core func (canon task.return)))")).toThrow(refused);
    expect(() => validateImportAbi("(component (core func (canon waitable-set.new)))")).toThrow(refused);
  });
  it("admits an ordinary synchronous component with no imports", () => {
    expect(() => validateImportAbi("(component (type (func (param \"x\" string))))")).not.toThrow();
  });
});
