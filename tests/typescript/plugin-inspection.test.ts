import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parse } from "../../packages/node_modules/@bytecodealliance/jco/dist/api.js";
import { authorityDigest, createPluginExecutor, HostImports, inspectPlugin, loadPlugin, readRequiredImports } from "../../packages/guests/plugin/index";
import { qualifiedImport } from "../../packages/guests/plugin/imports";

const interfaceName = "boundary:guest/footprints@1.0.0";
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/wasm-imports/${name}.component.wasm`, import.meta.url)));

it("reads numeric type indices, every resource member, direct functions and only root imports", async () => {
  const base = new URL("../fixtures/plugin-inspection/indexed-imports", import.meta.url);
  const bytes = new Uint8Array(readFileSync(new URL(`${base}.component.wasm`)));
  expect(bytes).toEqual(await parse(readFileSync(new URL(`${base}.wat`), "utf8")));
  expect((await readRequiredImports(bytes)).map(qualifiedImport)).toEqual([
    "direct-call",
    "boundary:guest/first@1.0.0#first",
    "boundary:guest/second@2.0.0#resource-handle",
    "boundary:guest/second@2.0.0#second",
  ]);
});

it("keeps full versions and raw escaped member names", async () => {
  const bytes = await parse(String.raw`(component
    (type $shape (instance (type (func))
      (export "raw\22name\5c\c3\a9" (func (type 0)))))
    (import "boundary:guest/footprints@9.9.9" (instance (type $shape))))`);
  const required = await readRequiredImports(bytes);
  expect(required).toEqual([{ instance: "boundary:guest/footprints@9.9.9", name: 'raw"name\\é' }]);
  expect(new HostImports(interfaceName).provide("images").check(required).status).toBe("refused");
});

it("orders decoded raw import fields before joining their display names", async () => {
  // These names exercise the decoder projection, not executable-name validity.
  const bytes = await parse(String.raw`(component (type (func))
    (type (instance (type (func))
      (export "b#x" (func (type 0)))
      (export "\ee\80\80" (func (type 0)))
      (export "\f0\90\80\80" (func (type 0)))))
    (import "a" (instance (type 1)))
    (type (instance (type (func)) (export "x" (func (type 0)))))
    (import "a#b" (instance (type 2)))
    (type (instance (type (func)) (export "empty-instance" (func (type 0)))))
    (import "" (instance (type 3)))
    (import "z" (func (type 0))))`);
  expect(await readRequiredImports(bytes)).toEqual([
    { instance: undefined, name: "z" },
    { instance: "", name: "empty-instance" },
    { instance: "a", name: "b#x" },
    { instance: "a", name: "\ue000" },
    { instance: "a", name: "\u{10000}" },
    { instance: "a#b", name: "x" },
  ]);
});

it("counts primitive types before a numeric imported instance reference", async () => {
  const bytes = await parse(`(component (type string)
    (type (instance (type (func)) (export "images" (func (type 0)))))
    (import "${interfaceName}" (instance (type 1))))`);
  expect(await readRequiredImports(bytes)).toEqual([{ instance: interfaceName, name: "images" }]);
});

it("inspects arbitrary core data without executing a trapping guest initializer", async () => {
  const bytes = await parse(String.raw`(component
    (core module (memory 1) (data (i32.const 0) "\ff\00")
      (func $start unreachable) (start $start))
    (core instance (instantiate 0)))`);
  expect(await readRequiredImports(bytes)).toEqual([]);
});

it("resolves imported instance type aliases without losing their exact members", async () => {
  const bytes = await parse(`(component
    (type $provider (instance
      (type $shape (instance (type (func)) (export "run" (func (type 0)))))
      (export "shape" (type (eq $shape)))))
    (import "provider" (instance $p (type $provider)))
    (alias export $p "shape" (type $alias))
    (import "derived" (instance (type $alias))))`);
  expect((await readRequiredImports(bytes)).map(qualifiedImport)).toEqual(["derived#run", "provider#shape"]);
});

it.each([
  {
    title: "chained imported instances and nested outer scopes",
    wat: `(component
      (type $leaf (instance (export "handle" (type (sub resource)))
        (type (func)) (export "run" (func (type 1)))))
      (type $container (instance
        (type $inner (instance
          (alias outer 2 $leaf (type $outerShape))
          (export "shape" (type (eq $outerShape)))))
        (export "inner" (instance (type $inner)))))
      (import "provider" (instance $p (type $container)))
      (alias export $p "inner" (instance $inner))
      (alias export $inner "shape" (type $shape))
      (alias outer 0 $shape (type $again))
      (import "derived" (instance (type $again))))`,
    expected: ["derived#handle", "derived#run", "provider#inner"],
  },
  {
    title: "defined and exported instances without allocating bag-local type slots",
    wat: `(component (type (func))
      (type (instance (type (func)) (export "local-run" (func (type 0)))))
      (instance (export "shape" (type 1)))
      (export "local" (instance 0))
      (alias export 1 "shape" (type))
      (type (instance (type (func)) (export "unrelated" (func (type 0)))))
      (alias outer 0 2 (type))
      (import "derived" (instance (type 4))))`,
    expected: ["derived#local-run"],
  },
  {
    title: "exported and outer-aliased components instantiated only as static shapes",
    wat: `(component $ROOT
      (component $maker
        (type $shape (instance (type (func)) (export "made-run" (func (type 0)))))
        (export "shape" (type $shape)))
      (export $published "maker" (component $maker))
      (alias outer $ROOT $published (component $again))
      (instance $made (instantiate $again))
      (export $publishedInstance "made" (instance $made))
      (alias export $publishedInstance "shape" (type $alias))
      (import "derived" (instance (type $alias))))`,
    expected: ["derived#made-run"],
  },
  {
    title: "components aliased from imported instance members",
    wat: `(component
      (type $factory (component
        (type $leaf (instance (type (func)) (export "run" (func (type 0)))))
        (export "shape" (type (eq $leaf)))))
      (type $provider (instance
        (alias outer 1 $factory (type $factoryHere))
        (export "factory" (component (type $factoryHere)))))
      (import "provider" (instance $p (type $provider)))
      (alias export $p "factory" (component $factoryAlias))
      (instance $made (instantiate $factoryAlias))
      (alias export $made "shape" (type $shape))
      (import "derived" (instance (type $shape))))`,
    expected: ["derived#run", "provider#factory"],
  },
  {
    title: "imported components with callable requirements confined to the root",
    wat: `(component
      (type $factory (component
        (type $leaf (instance (type (func)) (export "run" (func (type 0)))))
        (export "shape" (type (eq $leaf)))))
      (import "factory" (component $factoryImport (type $factory)))
      (instance $made (instantiate $factoryImport))
      (alias export $made "shape" (type $shape))
      (import "derived" (instance (type $shape))))`,
    expected: ["derived#run"],
  },
  {
    title: "export type ascriptions narrowing the new exported type slot",
    wat: `(component
      (type $small (instance (type (func)) (export "allowed" (func (type 0)))))
      (type $wide (instance (type (func))
        (export "allowed" (func (type 0))) (export "extra" (func (type 0)))))
      (export $narrow "shape" (type $wide) (type (eq $small)))
      (import "derived" (instance (type $narrow))))`,
    expected: ["derived#allowed"],
  },
  {
    title: "wider exported types supplied through an instance argument",
    wat: `(component
      (type $small (instance (type (func)) (export "allowed" (func (type 0)))))
      (type $wide (instance (type (func))
        (export "allowed" (func (type 0))) (export "extra" (func (type 0)))))
      (type $provider (instance
        (alias outer 1 $small (type $smallHere))
        (export "shape" (type (eq $smallHere)))))
      (instance $actual (export "shape" (type $wide)))
      (component $forward
        (alias outer 1 $provider (type $expected))
        (import "provider" (instance $p (type $expected)))
        (alias export $p "shape" (type $shape))
        (export "shape" (type $shape)))
      (instance $made (instantiate $forward (with "provider" (instance $actual))))
      (alias export $made "shape" (type $resolved))
      (import "derived" (instance (type $resolved))))`,
    expected: ["derived#allowed", "derived#extra"],
  },
  {
    title: "instance arguments retaining their declared export set",
    wat: `(component
      (type $leaf (instance (type (func)) (export "allowed" (func (type 0)))))
      (type $provider (instance
        (alias outer 1 $leaf (type $leafHere))
        (export "shape" (type (eq $leafHere)))))
      (type $wideProvider (instance
        (alias outer 1 $leaf (type $leafHere))
        (export "shape" (type (eq $leafHere)))
        (type (func)) (export "extra" (func (type 2)))))
      (import "provider" (instance $actual (type $wideProvider)))
      (component $forward
        (alias outer 1 $provider (type $expected))
        (import "provider" (instance $p (type $expected)))
        (export "provider" (instance $p)))
      (instance $made (instantiate $forward (with "provider" (instance $actual))))
      (alias export $made "provider" (instance $narrow))
      (alias export $narrow "shape" (type $resolved))
      (import "derived" (instance (type $resolved))))`,
    expected: ["derived#allowed", "provider#extra", "provider#shape"],
  },
  {
    title: "component arguments retaining their declared exported type shapes",
    wat: `(component
      (type $small (instance (type (func)) (export "allowed" (func (type 0)))))
      (type $wide (instance (type (func))
        (export "allowed" (func (type 0))) (export "extra" (func (type 0)))))
      (type $factory (component
        (alias outer 1 $small (type $expectedShape))
        (export "shape" (type (eq $expectedShape)))))
      (component $actual
        (alias outer 1 $wide (type $actualShape))
        (export "shape" (type $actualShape)))
      (component $forward
        (alias outer 1 $factory (type $expectedFactory))
        (import "factory" (component $maker (type $expectedFactory)))
        (export "factory" (component $maker)))
      (instance $made (instantiate $forward (with "factory" (component $actual))))
      (alias export $made "factory" (component $resolvedFactory))
      (instance $produced (instantiate $resolvedFactory))
      (alias export $produced "shape" (type $resolvedShape))
      (import "derived" (instance (type $resolvedShape))))`,
    expected: ["derived#allowed"],
  },
  {
    title: "component scope names distinct from type identifiers",
    wat: `(component $ROOT
      (type $leaf (instance (type (func)) (export "root-run" (func (type 0)))))
      (type $ROOT (instance
        (type $decoy (instance (type (func)) (export "decoy" (func (type 0)))))
        (alias outer 1 $leaf (type $actual))
        (export "shape" (type (eq $actual)))))
      (import "provider" (instance $p (type $ROOT)))
      (alias export $p "shape" (type $derived))
      (import "derived" (instance (type $derived))))`,
    expected: ["derived#root-run", "provider#shape"],
  },
  {
    title: "core type aliases inside imported instance module members",
    wat: `(component
      (core rec (type $signature (func)) (type $other (func (param i32))))
      (core type $module (module
        (alias outer 1 $signature (type $localSignature))
        (export "invoke" (func (type $localSignature)))))
      (type $provider (instance
        (alias outer 1 $module (core type $localModule))
        (export "module" (core module (type $localModule)))
        (export "handle" (type (sub resource)))))
      (import "provider" (instance (type $provider))))`,
    expected: ["provider#handle", "provider#module"],
  },
])("resolves $title", async ({ wat, expected }) => {
  expect((await readRequiredImports(await parse(wat))).map(qualifiedImport)).toEqual(expected);
});

it.each([
  `(component (type (instance (type (func)) (export "run" (func (type 0)))))
    (import "provider" (instance (type 0))) (alias export 0 "missing" (type)))`,
  `(component (type (instance (type (func)) (export "run" (func (type 0)))))
    (import "provider" (instance (type 0))) (alias export 0 "run" (type)))`,
  `(component (type (func)) (alias outer 1 0 (type)))`,
  `(component (type (func)) (alias outer 0 99 (type)))`,
  `(component (type (instance (alias outer 1 1 (type)))))`,
  `(component (type (instance)) (alias export 99 "shape" (type)))`,
  `(component (type $small (instance))
    (type $wide (instance (type (func)) (export "run" (func (type 0)))))
    (import "provider" (instance $p (type $wide)))
    (export $narrow "narrow" (instance $p) (instance (type $small)))
    (alias export $narrow "run" (func)))`,
])("rejects invalid or unresolved aliases without omitting imports: %s", async (wat) => {
  await expect(readRequiredImports(await parse(wat))).rejects.toThrow();
});

it("rejects malformed and core module artifacts before worker preparation", async () => {
  const executor = createPluginExecutor();
  try {
    for (const bytes of [fixture("compliant").subarray(0, 12), new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0, 7, 128]), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])]) {
      await expect(readRequiredImports(bytes)).rejects.toThrow();
      expect(await loadPlugin({ executor, bytes, imports: new HostImports(interfaceName), witDigest: "malformed", host: {} }))
        .toMatchObject({ status: "fault", certainty: "not-started" });
    }
    expect(executor.stats()).toMatchObject({ workers: 0, preparations: 0 });
  } finally { await executor.close(); }
});

it("captures artifact bytes and provided authority before asynchronous decoding", async () => {
  const bytes = fixture("overreach");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const imports = new HostImports(interfaceName).provide("images");
  const authority = authorityDigest(imports);
  const inspecting = inspectPlugin(bytes, imports, "snapshot");
  bytes.fill(0);
  imports.provide("publications");
  const result = await inspecting;
  expect(result.componentDigest).toBe(digest);
  expect(result.authorityDigest).toBe(authority);
  expect(result.check).toEqual({ status: "refused", unmapped: [`${interfaceName}#publications`], provided: ["images"] });
});

it("does not widen missing-host refusal evidence while decoding yields", async () => {
  const executor = createPluginExecutor();
  const imports = new HostImports(interfaceName).provide("images");
  try {
    const loading = loadPlugin({ executor, bytes: fixture("compliant"), imports, witDigest: "snapshot", host: {} });
    imports.provide("publications");
    expect(await loading).toEqual({ status: "refused", unmapped: [`${interfaceName}#images`], provided: ["images"] });
    expect(executor.stats()).toMatchObject({ preparations: 0, workers: 0 });
  } finally { await executor.close(); }
});

it("keeps the chosen executor and host functions when caller records change during decoding", async () => {
  const first = createPluginExecutor();
  const replacement = createPluginExecutor();
  const original = () => "original";
  const changed = () => "changed";
  const firstBind = vi.spyOn(first, "bind").mockResolvedValue({ status: "fault", certainty: "not-started", reason: "captured fixture" });
  const replacementBind = vi.spyOn(replacement, "bind");
  const host = { images: original };
  const args = { executor: first, bytes: fixture("compliant"), imports: new HostImports(interfaceName).provide("images"), witDigest: "snapshot", host };
  try {
    const loading = loadPlugin(args);
    host.images = changed;
    args.host = { images: changed };
    args.executor = replacement;
    await loading;
    expect(firstBind).toHaveBeenCalledOnce();
    expect(firstBind.mock.calls[0]?.[2].images).toBe(original);
    expect(replacementBind).not.toHaveBeenCalled();
  } finally { await first.close(); await replacement.close(); }
});
