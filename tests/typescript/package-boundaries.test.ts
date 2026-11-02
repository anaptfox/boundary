import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM check helper without declarations
import { moduleSpecifiers, sourceResolver } from "../../scripts/check/module-graph.mjs";

const root = path.join(process.cwd(), "packages");
const groups = ["core", "discovery", "guests", "callers", "adapters"];
describe("SDK ownership boundaries", () => {
  it("publishes one SDK with explicit capability subpaths", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.name).toBe("@foxworth/boundary");
    // The source manifest is packed with publishConfig applied; publishing
    // straight from packages/ is refused; release.yml stages verified candidates.
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.scripts.prepublishOnly).toContain("release.yml");
    for (const subpath of ["program", "handoff", "control", "reach", "bus", "plugin", "client", "http", "react", "mcp", "webmcp"]) {
      expect(manifest.exports).toHaveProperty(`./${subpath}`);
    }
    for (const [key, target] of Object.entries(manifest.exports) as [string, string][]) {
      if (key === "./package.json") continue;
      expect(groups).toContain(target.split("/")[1]);
      expect(existsSync(path.join(root, target))).toBe(true);
    }
    for (const group of groups) {
      for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) {
        if (entry.isDirectory()) expect(existsSync(path.join(root, group, entry.name, "package.json"))).toBe(false);
      }
    }
  });
});

// Module rules for packages/<group>/<module>: cross-module imports go through
// the owner's public subpath (or the package-private #program/internal), the
// module graph stays acyclic, and Handoff never depends on Host. Specifiers come
// from oxc's parser (every import form, including type-only and `import()`), and
// edges come from oxc-resolver following the package's exports and imports.
describe("SDK module dependency rules", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const resolve = sourceResolver();
  const moduleOf = (file: string) => {
    const relative = path.relative(root, file);
    const [group, module] = relative.split(path.sep);
    return !relative.startsWith("..") && groups.includes(group!) && module ? `${group}/${module}` : undefined;
  };
  const files: { file: string; module: string; imports: { specifier: string; target: string | undefined }[] }[] = [];
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") collect(file);
      } else if (/\.tsx?$/u.test(entry.name)) {
        files.push({
          file: path.relative(root, file),
          module: moduleOf(file)!,
          imports: moduleSpecifiers(file).map((specifier: string) => {
            let target: string | undefined;
            try { target = resolve(file, specifier); } catch { target = undefined; }
            return { specifier, target };
          }),
        });
      }
    }
  }
  for (const group of groups) collect(path.join(root, group));
  const edges = new Map<string, Set<string>>();
  for (const { module, imports } of files) {
    for (const { target } of imports) {
      const owner = target ? moduleOf(target) : undefined;
      if (owner && owner !== module) {
        if (!edges.has(module)) edges.set(module, new Set());
        edges.get(module)!.add(owner);
      }
    }
  }

  it("resolves every internal specifier", () => {
    const unresolved = files.flatMap(({ file, imports }) =>
      imports
        .filter(({ specifier, target }) => target === undefined && (specifier.startsWith(".") || specifier.startsWith("#") || specifier.startsWith(manifest.name)))
        .map(({ specifier }) => `${file}: ${specifier}`),
    );
    expect(unresolved).toEqual([]);
  });

  it("never reaches into another module's files by relative path", () => {
    const crossings = files.flatMap(({ file, module, imports }) =>
      imports
        .filter(({ specifier, target }) => specifier.startsWith(".") && target && moduleOf(target) !== module)
        .map(({ target }) => `${file} -> ${path.relative(root, target!)}`),
    );
    expect(crossings).toEqual([]);
  });

  it("keeps the module graph acyclic", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (module: string, trail: string[]) => {
      if (done.has(module)) return;
      if (visiting.has(module)) {
        cycles.push([...trail.slice(trail.indexOf(module)), module].join(" -> "));
        return;
      }
      visiting.add(module);
      for (const next of edges.get(module) ?? []) visit(next, [...trail, module]);
      visiting.delete(module);
      done.add(module);
    };
    for (const module of edges.keys()) visit(module, []);
    expect(cycles).toEqual([]);
  });

  it("keeps Program dependency-free and Handoff independent of Host", () => {
    expect([...(edges.get("core/program") ?? [])]).toEqual([]);
    expect(edges.get("core/handoff")?.has("core/host") ?? false).toBe(false);
  });

  it("keeps package-private helpers out of the public surface", async () => {
    expect(Object.keys(manifest.exports).some((key) => key.includes("internal"))).toBe(false);
    expect(Object.values(manifest.exports as Record<string, string>)).not.toContain(manifest.imports["#program/internal"]);
    const program = await import("../../packages/core/program/index");
    for (const name of ["compareUtf8", "exactObject", "snapshotJson", "compileSchema"]) {
      expect(program).not.toHaveProperty(name);
    }
    const testRoot = path.join(process.cwd(), "tests", "typescript");
    const outside = readdirSync(testRoot)
      .filter((name) => /\.tsx?$/u.test(name) && name !== "package-boundaries.test.ts")
      .filter((name) => moduleSpecifiers(path.join(testRoot, name)).some((specifier: string) => specifier.startsWith("#")));
    expect(outside).toEqual([]);
  });
});
