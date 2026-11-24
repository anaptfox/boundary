import type {
  Projection,
  ProjectionBinding,
  ProjectionBindingInteraction,
} from "@foxworth/boundary";
import {
  createCheckedHandoff,
  type HandoffFaultCause,
} from "@foxworth/boundary/handoff";
import type { InvocationCertainty, JsonObject, JsonSchema, InteractionDescriptor } from "@foxworth/boundary/program";
import { AdapterError } from "#remote";
import type { HttpRoute } from "./handler";
import { compileBindingResolution, compileProjectionResolution, interactionKey } from "#remote";

type OpenApiCommon = Readonly<{
  routes: readonly HttpRoute[];
  title: string;
  version: string;
}>;

export type OpenApiOptions<Context = unknown> = OpenApiCommon & (
  | Readonly<{ projection: Projection<any>; binding?: never }>
  | Readonly<{ binding: ProjectionBinding<any, Context>; projection?: never }>
);

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("UNSUPPORTED_SCHEMA", path, "HTTP input schemas must be objects");
  }
  return value as JsonObject;
}

function parameterNames(path: string): readonly string[] {
  return Object.freeze(path
    .split("/")
    .filter((segment) => segment.startsWith("{") && segment.endsWith("}"))
    .map((segment) => segment.slice(1, -1)));
}

function propertySchemas(schema: JsonSchema): JsonObject {
  const root = object(schema, "route.inputSchema");
  return root.properties === undefined
    ? Object.freeze({})
    : object(root.properties, "route.inputSchema.properties");
}

function withoutProperties(schema: JsonSchema, excluded: ReadonlySet<string>): JsonObject {
  const root = object(schema, "route.inputSchema");
  const properties = propertySchemas(schema);
  const required = Array.isArray(root.required)
    ? root.required.filter((name): name is string => typeof name === "string" && !excluded.has(name))
    : [];
  return {
    ...root,
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !excluded.has(name))),
    ...(root.required === undefined ? {} : { required }),
  };
}

function identityProperties(
  descriptor: InteractionDescriptor,
  mode: "direct" | "request",
  binding?: ProjectionBindingInteraction,
  installationId?: string,
): JsonObject {
  return {
    version: { const: 1 },
    bindingDigest: { type: "string", pattern: "^sha256:" },
    installationId: installationId === undefined
      ? { type: "string" }
      : { const: installationId },
    interactionId: { const: descriptor.contract.id },
    expectedContractDigest: { const: descriptor.contractDigest },
    actualContractDigest: binding
      ? { const: binding.actualContractDigest }
      : { type: "string", pattern: "^sha256:" },
    mode: { const: mode },
    realizationId: binding
      ? { const: binding.realizationId }
      : { type: "string" },
  };
}

type OutcomeBranch = Readonly<{
  certainty: InvocationCertainty;
  result: JsonSchema;
}>;

function outcomeSchema(
  descriptor: InteractionDescriptor,
  mode: "direct" | "request",
  branches: readonly OutcomeBranch[],
  bindingDigest?: string,
  binding?: ProjectionBindingInteraction,
  installationId?: string,
): JsonObject {
  const properties: Record<string, JsonSchema> = {
    ...identityProperties(descriptor, mode, binding, installationId),
    ...(bindingDigest === undefined
      ? {}
      : { bindingDigest: { const: bindingDigest } }),
  };
  return {
    oneOf: branches.map(({ certainty, result }) => ({
      type: "object",
      additionalProperties: false,
      required: [
        "version",
        "bindingDigest",
        "installationId",
        "interactionId",
        "expectedContractDigest",
        "actualContractDigest",
        "mode",
        "realizationId",
        "certainty",
        "result",
      ],
      properties: {
        ...properties,
        certainty: { const: certainty },
        result,
      },
    })),
  };
}

function response(description: string, schema: JsonSchema): JsonObject {
  return { description, content: { "application/json": { schema } } };
}

const validationIssue: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "message"],
  properties: {
    path: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
  },
};

function faultResult(
  causes: readonly string[],
  issues = false,
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "cause", ...(issues ? ["issues"] : [])],
    properties: {
      kind: { const: "fault" },
      cause: causes.length === 1 ? { const: causes[0]! } : { enum: causes },
      ...(issues
        ? {
            issues: {
              type: "array",
              minItems: 1,
              items: validationIssue,
            },
          }
        : {}),
    },
  };
}

function faultBranch(
  certainty: InvocationCertainty,
  cause: HandoffFaultCause,
): OutcomeBranch {
  return Object.freeze({ certainty, result: faultResult([cause]) });
}

function internalFaultBranches(
  mode: "direct" | "request",
): readonly OutcomeBranch[] {
  if (mode === "request") {
    return Object.freeze([
      faultBranch("not-started", "admission-failed"),
      faultBranch("not-started", "request-failed"),
    ]);
  }
  return Object.freeze([
    faultBranch("not-started", "admission-failed"),
    faultBranch("unknown", "invalid-realization-outcome"),
    faultBranch("not-started", "realization-failed"),
    faultBranch("not-completed", "realization-failed"),
    faultBranch("unknown", "realization-failed"),
  ]);
}

function declaredResultSchema(errorSchema: JsonSchema): JsonSchema {
  const addKind = (schema: unknown): JsonObject => {
    const root = object(schema, "route.errorSchema");
    const properties = root.properties === undefined
      ? Object.freeze({})
      : object(root.properties, "route.errorSchema.properties");
    const required = Array.isArray(root.required)
      ? root.required.filter((value): value is string => typeof value === "string")
      : [];
    return {
      ...root,
      properties: { ...properties, kind: { const: "declared-error" } },
      required: [...required, "kind"],
    };
  };
  const root = object(errorSchema, "route.errorSchema");
  return Array.isArray(root.oneOf)
    ? { oneOf: root.oneOf.map(addKind) }
    : addKind(root);
}

function interactionPath(
  route: HttpRoute,
  descriptor: InteractionDescriptor,
  bindingDigest?: string,
  binding?: ProjectionBindingInteraction,
  installationId?: string,
): JsonObject {
  if (route.inputMapping === "custom") {
    throw new AdapterError(
      "INVALID_DECLARATION",
      `${descriptor.contract.id}.route.input`,
      "OpenAPI cannot infer a custom route input mapping",
    );
  }
  const names = parameterNames(route.path);
  const excluded = new Set(names);
  const inputSchema = descriptor.contract.inputSchema;
  const mapsObjectProperties = route.method === "GET" || names.length > 0;
  const inputObject = mapsObjectProperties ? object(inputSchema, "route.inputSchema") : undefined;
  const properties: JsonObject = mapsObjectProperties
    ? propertySchemas(inputSchema)
    : Object.freeze({});
  const required = new Set(
    Array.isArray(inputObject?.required) ? inputObject.required as readonly string[] : [],
  );
  const parameters: JsonObject[] = names.map((name) => {
    const schema = properties[name];
    if (!schema) {
      throw new AdapterError(
        "INVALID_DECLARATION",
        `${descriptor.contract.id}.route.path.${name}`,
        `path parameter ${name} is absent from the interaction input contract`,
      );
    }
    return { name, in: "path", required: true, schema };
  });
  if (route.method === "GET") {
    for (const [name, schema] of Object.entries(properties)) {
      if (!excluded.has(name)) {
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema: schema as JsonSchema,
        });
      }
    }
  }

  const successResult: JsonSchema = route.mode === "direct"
    ? {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: { kind: { const: "returned" }, value: descriptor.contract.outputSchema },
      }
    : {
        type: "object",
        additionalProperties: false,
        required: ["kind", "proposal"],
        properties: {
          kind: { const: "proposed" },
          proposal: binding?.request?.previewSchema ?? {},
        },
      };
  const responses: Record<string, JsonSchema> = {
    [String(route.successStatus ?? (route.mode === "request" ? 202 : 200))]: response(
      "Interaction completed",
      outcomeSchema(
        descriptor,
        route.mode,
        [{
          certainty: route.mode === "request" ? "not-started" : "completed",
          result: successResult,
        }],
        bindingDigest,
        binding,
        installationId,
      ),
    ),
    "400": response(
      "Invalid input or invocation",
      outcomeSchema(
        descriptor,
        route.mode,
        [
          {
            certainty: "not-started",
            result: faultResult(["invalid-input"], true),
          },
          {
            certainty: "not-started",
            result: faultResult(["invalid-invocation"]),
          },
        ],
        bindingDigest,
        binding,
        installationId,
      ),
    ),
    "403": response(
      "Admission denied",
      outcomeSchema(
        descriptor,
        route.mode,
        [{
          certainty: "not-started",
          result: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "code"],
            properties: {
              kind: { const: "denied" },
              code: { type: "string" },
            },
          },
        }],
        bindingDigest,
        binding,
        installationId,
      ),
    ),
    "409": response(
      "Binding revoked",
      outcomeSchema(
        descriptor,
        route.mode,
        [faultBranch("not-started", "revoked")],
        bindingDigest,
        binding,
        installationId,
      ),
    ),
    "500": response(
      "Undeclared failure",
      outcomeSchema(
        descriptor,
        route.mode,
        internalFaultBranches(route.mode),
        bindingDigest,
        binding,
        installationId,
      ),
    ),
  };
  if (
    route.mode === "direct" &&
    descriptor.contract.errorSchema !== undefined
  ) {
    responses["422"] = response(
      "Declared domain error",
      outcomeSchema(
        descriptor,
        route.mode,
        [{
          certainty: "completed",
          result: declaredResultSchema(descriptor.contract.errorSchema),
        }],
        bindingDigest,
        binding,
        installationId,
      ),
    );
  }
  return {
    interactionId: descriptor.contract.id,
    ...(descriptor.docs.summary === undefined ? {} : { summary: descriptor.docs.summary }),
    ...(descriptor.docs.description === undefined ? {} : { description: descriptor.docs.description }),
    "x-boundary-contract-digest": descriptor.contractDigest,
    "x-boundary-mode": route.mode,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(route.method === "GET" || route.handle.inputArity === 0
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: names.length === 0 ? inputSchema : withoutProperties(inputSchema, excluded),
              },
            },
          },
        }),
    responses,
  };
}

/** Describe exactly the routes supplied by the application. */
export async function openapi<Context>(options: OpenApiOptions<Context>): Promise<JsonObject> {
  const declarations = options.routes.map((route) => ({ handle: route.handle, mode: route.mode }));
  let resolved: ReadonlyMap<string, Readonly<{
    descriptor: InteractionDescriptor;
    binding?: ProjectionBindingInteraction;
  }>>;
  let bindingDigest: string | undefined;
  let installationId: string | undefined;
  let programDigest: string;
  let sourceDigest: string;
  if (options.binding !== undefined) {
    const handoff = await createCheckedHandoff(options.binding);
    const binding = await compileBindingResolution(handoff, declarations);
    bindingDigest = binding.manifest.bindingDigest;
    installationId = binding.manifest.installationId;
    programDigest = binding.manifest.expectedProgramDigest;
    sourceDigest = binding.manifest.projectionDigest;
    resolved = new Map([...binding.interactions].map(([key, value]) => [key, {
      descriptor: value.expected,
      binding: value.binding,
    }]));
  } else {
    const projection = await compileProjectionResolution(options.projection, declarations);
    programDigest = projection.projection.program.programDigest;
    sourceDigest = projection.projection.projectionDigest;
    resolved = new Map([...projection.interactions].map(([key, value]) => [key, {
      descriptor: value.descriptor,
    }]));
  }

  const paths: Record<string, JsonSchema> = {};
  const seen = new Set<string>();
  for (const [index, route] of options.routes.entries()) {
    const routeKey = `${route.method} ${route.path}`;
    if (seen.has(routeKey)) {
      throw new AdapterError("DUPLICATE_DECLARATION", `routes[${index}]`, `duplicate route: ${routeKey}`);
    }
    seen.add(routeKey);
    const interaction = resolved.get(interactionKey(route.handle.interactionId, route.mode))!;
    const path = (paths[route.path] ?? {}) as Record<string, JsonSchema>;
    path[route.method.toLowerCase()] = interactionPath(
      route,
      interaction.descriptor,
      bindingDigest,
      interaction.binding,
      installationId,
    );
    paths[route.path] = path;
  }
  return {
    openapi: "3.1.0",
    info: { title: options.title, version: options.version },
    "x-boundary-program-digest": programDigest,
    "x-boundary-projection-digest": sourceDigest,
    ...(bindingDigest === undefined ? {} : { "x-boundary-binding-digest": bindingDigest }),
    paths,
  };
}
