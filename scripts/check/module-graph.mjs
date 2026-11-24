// Module specifiers and resolution for checks over source and built output.
//
// Parsing uses oxc so every import form is seen: static imports and re-exports,
// `export *`, type-only forms, literal `import()` calls, and `import("…")` types
// in declaration files. Resolution uses oxc-resolver, which follows package
// `exports`, the package-private `imports` map (`#…`), conditions, and pnpm.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";

function languageOf(file) {
  if (file.endsWith(".d.ts")) return "dts";
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "ts";
  return "js";
}

/** Every module specifier a file names, in source order of discovery. */
export function moduleSpecifiers(file, source = readFileSync(file, "utf8")) {
  const { program, module, errors } = parseSync(file, source, { lang: languageOf(file) });
  if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
  const specifiers = [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) => entry.entries.map((item) => item.moduleRequest?.value)).filter(Boolean),
  ];
  for (const dynamic of module.dynamicImports) {
    const text = source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
    const literal = /^(["'])(.*)\1$/su.exec(text);
    if (literal) specifiers.push(literal[2]);
  }
  new Visitor({
    TSImportType(node) {
      const value = node.argument?.literal?.value ?? node.source?.value;
      if (typeof value === "string") specifiers.push(value);
    },
  }).visit(program);
  return specifiers;
}

/** Runtime module specifiers, excluding imports and exports erased by TypeScript. */
export function runtimeModuleSpecifiers(file, source = readFileSync(file, "utf8")) {
  const { program, module, errors } = parseSync(file, source, { lang: languageOf(file) });
  if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
  const specifiers = [];
  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind !== "type" && (node.specifiers.length === 0 || node.specifiers.some((entry) => entry.importKind !== "type"))) {
        specifiers.push(node.source.value);
      }
    } else if (node.type === "ExportAllDeclaration") {
      if (node.exportKind !== "type") specifiers.push(node.source.value);
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      if (node.exportKind !== "type" && node.specifiers.some((entry) => entry.exportKind !== "type")) {
        specifiers.push(node.source.value);
      }
    }
  }
  for (const dynamic of module.dynamicImports) {
    const text = source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
    const literal = /^("|')(.*)\1$/su.exec(text);
    if (literal) specifiers.push(literal[2]);
  }
  return specifiers;
}

/** A resolver for TypeScript source inside this repository. */
export function sourceResolver() {
  const resolver = new ResolverFactory({
    conditionNames: ["node", "import", "default"],
    extensions: [".ts", ".tsx", ".js", ".mjs"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  });
  return (fromFile, specifier) => {
    const result = resolver.sync(path.dirname(fromFile), specifier);
    return result.path;
  };
}
