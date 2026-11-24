import { describe, expect, it, vi } from "vitest";

const validatorState = vi.hoisted(() => ({ schemas: [] as unknown[] }));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@modelcontextprotocol/server")
  >();
  const { CfWorkerJsonSchemaValidator } = await import(
    "@modelcontextprotocol/server/validators/cf-worker"
  );
  const validator = new CfWorkerJsonSchemaValidator();
  return {
    ...original,
    fromJsonSchema<Output>(schema: unknown) {
      validatorState.schemas.push(schema);
      return original.fromJsonSchema<Output>(
        schema as Parameters<typeof original.fromJsonSchema>[0],
        validator,
      );
    },
  };
});

import { projectInteractions } from "@foxworth/boundary";
import { createMcpServer, tool } from "@foxworth/boundary/mcp";
import { createAdapterFixture } from "./helpers/adapter";

describe("MCP schema ownership", () => {
  it("detaches frozen Program schemas before Cloudflare validator compilation", async () => {
    const fixture = await createAdapterFixture();
    const projection = projectInteractions(fixture.compiled, {
      create: {
        interaction: fixture.compiled.handles.create,
        modes: ["direct"],
      },
    });
    const binding = await fixture.bind(projection);
    const original = binding.manifest.expectedProgram.interactions[0]!.contract.inputSchema as Record<
      string,
      unknown
    >;

    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.properties)).toBe(true);

    const server = await createMcpServer({
      name: "frozen-schema-test",
      version: "1.0.0",
      binding,
      context: () => ({ role: "owner" as const }),
      tools: [tool(projection.handles.create)],
    });
    await server.close();

    const compiled = validatorState.schemas.at(-1) as Record<string, unknown>;
    expect(compiled).not.toBe(original);
    expect(compiled.properties).not.toBe(original.properties);
    expect(compiled).toEqual(original);
    expect(Object.isExtensible(compiled)).toBe(true);
    expect(Object.hasOwn(compiled, "__absolute_uri__")).toBe(true);
    expect(Object.hasOwn(original, "__absolute_uri__")).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);
  });
});
