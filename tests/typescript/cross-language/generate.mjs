// Test-fixture generator. This bounded schema subset is not a public codegen API.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function typeOf(schema) {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (schema.type) {
    case "null": return "null";
    case "string": return "string";
    case "boolean": return "boolean";
    case "array": return `ReadonlyArray<${typeOf(schema.items)}>`;
    case "object": {
      if (schema.additionalProperties !== false) throw new Error("fixture requires closed objects");
      return `{ ${Object.entries(schema.properties).map(([name, field]) =>
        `readonly ${JSON.stringify(name)}${schema.required?.includes(name) ? "" : "?"}: ${typeOf(field)}`,
      ).join("; ")} }`;
    }
    default: throw new Error(`unsupported fixture schema: ${JSON.stringify(schema)}`);
  }
}

const child = spawnSync(process.env.BOUNDARY_CROSS_LANGUAGE_TODO_HOST ?? resolve("target/debug/examples/cross_language_todo"), [], {
  input: '{"kind":"inspect"}\n', encoding: "utf8", timeout: 10_000, maxBuffer: 2_000_000,
});
if (child.error) throw child.error;
if (child.status !== 0) throw new Error(child.stderr || "Rust fixture did not exit successfully");
const response = JSON.parse(child.stdout);
if (!response.ok) throw new Error("Rust fixture handshake failed");
const manifest = response.value;
const declarations = manifest.actualProgram.interactions;
const entries = manifest.interactions;
const members = entries.map((entry) => {
  const declaration = declarations.find((item) => item.contract.id === entry.interactionId);
  if (!declaration || entry.mode !== "direct" || declaration.contractDigest !== entry.expectedContractDigest) throw new Error("unexpected fixture identity");
  return `  readonly ${JSON.stringify(entry.alias)}: ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<${JSON.stringify(entry.interactionId)}, ${typeOf(declaration.contract.inputSchema)}, ${typeOf(declaration.contract.outputSchema)}, Record<string, JsonValue>, ${entry.inputArity}>>, readonly ["direct"]>;`;
});
const values = entries.map((entry) => `  ${JSON.stringify(entry.alias)}: Object.freeze({ interactionId: ${JSON.stringify(entry.interactionId)}, contractDigest: ${JSON.stringify(entry.expectedContractDigest)}, inputArity: ${entry.inputArity}, modes: Object.freeze(["direct"] as const) }),`);
const source = `// Generated from the native Rust fixture by tests/typescript/cross-language/generate.mjs.\n// Input/output types only; no declared-error interoperability claim.\nimport type { InteractionDefinition, InteractionHandle, ProjectedInteractionHandle } from "@foxworth/boundary";\nimport type { JsonValue } from "@foxworth/boundary/program";\n\nexport const references: Readonly<{\n${members.join("\n")}\n}> = Object.freeze({\n${values.join("\n")}\n});\n`;
const destination = new URL("./references.ts", import.meta.url);
if (process.argv.includes("--write")) writeFileSync(destination, source);
else if (readFileSync(destination, "utf8") !== source) throw new Error("fixture references drifted; review then regenerate with --write");
console.log("Cross-language fixture references match native Rust declarations.");
