import { isPortableSchema, type PortableSchema, type SchemaCompilation } from "@foxworth/boundary/program";
import { compileSchema } from "#program/internal";
import { zodSchemaAdapter } from "@foxworth/boundary/program/zod";
import { failHost } from "./errors";
import type { CompileInteractionsOptions, SchemaAdapter } from "./types";

const portableAuthoringSchemaAdapter: SchemaAdapter<PortableSchema> =
  Object.freeze({
    supports: isPortableSchema,
    compile(schema: PortableSchema) {
      return { contract: schema };
    },
  });

const builtinSchemaAdapters: readonly SchemaAdapter<any>[] = Object.freeze([
  portableAuthoringSchemaAdapter,
  zodSchemaAdapter,
]);

export function schemaAdapters(
  value: CompileInteractionsOptions | undefined,
): readonly SchemaAdapter<any>[] {
  if (value === undefined) return builtinSchemaAdapters;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failHost(
      "INVALID_DECLARATION",
      "compileInteractions.options",
      "compile options must be an object",
    );
  }
  const unexpected = Reflect.ownKeys(value).find((key) => key !== "schemas");
  if (unexpected !== undefined) {
    return failHost(
      "INVALID_DECLARATION",
      `compileInteractions.options.${String(unexpected)}`,
      "compile options support only schema adapters",
    );
  }
  if (value.schemas === undefined) return builtinSchemaAdapters;
  if (!Array.isArray(value.schemas)) {
    return failHost(
      "INVALID_DECLARATION",
      "compileInteractions.options.schemas",
      "schema adapters must be an array",
    );
  }
  const explicit = value.schemas.map((adapter, index) => {
    if (
      adapter === null ||
      typeof adapter !== "object" ||
      typeof adapter.supports !== "function" ||
      typeof adapter.compile !== "function"
    ) {
      return failHost(
        "INVALID_DECLARATION",
        `compileInteractions.options.schemas[${index}]`,
        "each schema adapter must expose supports and compile functions",
      );
    }
    const supports = adapter.supports;
    const compile = adapter.compile;
    return Object.freeze({
      supports(value: unknown): value is unknown {
        return supports.call(adapter, value);
      },
      compile(schema: unknown, context: Parameters<typeof compile>[1]) {
        return compile.call(adapter, schema, context);
      },
    }) as SchemaAdapter<unknown>;
  });
  return Object.freeze([
    ...explicit,
    ...builtinSchemaAdapters.filter((builtin) => !value.schemas!.includes(builtin)),
  ]);
}

export function compileAuthoringSchema(
  adapters: readonly SchemaAdapter<any>[],
  schema: unknown,
  role: "input" | "output" | "error",
  path: string,
): SchemaCompilation {
  let adapter: SchemaAdapter<any> | undefined;
  for (const candidate of adapters) {
    let supported: boolean;
    try {
      supported = candidate.supports(schema);
    } catch (cause) {
      return failHost(
        "INVALID_DECLARATION",
        path,
        "schema adapter support detection failed",
        cause,
      );
    }
    if (supported) {
      adapter = candidate;
      break;
    }
  }
  if (!adapter) {
    return failHost(
      "INVALID_DECLARATION",
      path,
      "no schema adapter supports this authoring schema",
    );
  }
  return compileSchema(schema, adapter, { role, path });
}
