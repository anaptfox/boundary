import { portableSchema } from "@foxworth/boundary/program";
import {
  admitAll,
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createMcpServer, tool } from "@foxworth/boundary/mcp";

if (!process.execArgv.includes("--conditions=workerd")) {
  throw new Error("run with node --conditions=workerd");
}

const CreateInput = portableSchema({
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    metadata: {
      type: "object",
      properties: { priority: { type: "integer" } },
      required: ["priority"],
      additionalProperties: false,
    },
  },
  required: ["title", "metadata"],
  additionalProperties: false,
});
const CreateOutput = portableSchema({
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
  additionalProperties: false,
});
const interactions = {
  create: defineInteraction({
    id: "todos.create",
    input: CreateInput,
    output: CreateOutput,
    reads: ["todos"],
    changes: ["todos"],
  }),
};
const compiled = compileInteractions(interactions);
const implementations = implementInteractions(interactions, {
  create: () => ({ id: 1 }),
});
const { installation } = installInteractions(compiled, {
  installationId: "smoke:mcp-workerd:1",
  implementations,
  realizationIds: {
    create: { direct: "smoke:mcp-workerd:create:1" },
  },
});
const projection = projectInteractions(compiled, {
  create: { interaction: compiled.handles.create, modes: ["direct"] },
});
const result = bindProjection(projection, installation, {
  admit: admitAll,
});
if (result.status !== "bound") {
  throw new Error("workerd MCP smoke Binding could not be realized");
}
const schema = result.binding.manifest.expectedProgram.interactions[0].contract.inputSchema;

if (!Object.isFrozen(schema)) {
  throw new Error("bound expected Program schema is not frozen");
}

const server = await createMcpServer({
  name: "frozen-schema-workerd-smoke",
  version: "2.0.0",
  binding: result.binding,
  context: () => undefined,
  tools: [tool(projection.handles.create)],
});
await server.close();

if (!Object.isFrozen(schema) || Object.hasOwn(schema, "__absolute_uri__")) {
  throw new Error("MCP adapter mutated bound Program identity");
}

console.log("bound workerd MCP accepts frozen Program schemas");
