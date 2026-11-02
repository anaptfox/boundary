import { describe, expect, it } from "vitest";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectInteractions } from "@foxworth/boundary/pipeline";
import { defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Empty = portableSchema<Readonly<Record<string, never>>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});
const Result = portableSchema<Readonly<{ ok: true }>>({
  type: "object",
  properties: { ok: { const: true } },
  required: ["ok"],
  additionalProperties: false,
});

describe("native CompiledSurface handles", () => {
  it("keeps zero arity distinct from an explicit empty-object input", async () => {
    const interactions = {
      implicitEmpty: defineInteraction({ id: "arity.implicit", output: Result }),
      explicitEmpty: defineInteraction({
        id: "arity.explicit",
        input: Empty,
        output: Result,
      }),
    } as const;
    const compiled = await compileInteractions(interactions);
    const projection = await projectInteractions(compiled, {
      implicitEmpty: {
        interaction: compiled.handles.implicitEmpty,
        modes: ["direct"],
      },
      explicitEmpty: {
        interaction: compiled.handles.explicitEmpty,
        modes: ["direct"],
      },
    });

    expect(projection.handles.implicitEmpty.inputArity).toBe(0);
    expect(projection.handles.explicitEmpty.inputArity).toBe(1);
    expect(projection.handles.implicitEmpty).toMatchObject({
      interactionId: "arity.implicit",
      modes: ["direct"],
    });
  });

  it("binds one CompiledSurface atomically and preserves exact per-call context", async () => {
    type Context = Readonly<{ marker: object }>;
    const seen: Context[] = [];
    const interactions = {
      run: defineInteraction({ id: "native.run", output: Result }),
    } as const;
    const compiled = await compileInteractions(interactions);
    const implementations = implementInteractions<typeof interactions, Context>(interactions, {
      run(context) {
        seen.push(context);
        return { ok: true };
      },
    });
    const { installation } = await installInteractions<typeof interactions, Context>(compiled, {
      installationId: "installation:native:2",
      implementations,
      realizationIds: { run: { direct: "realization:native:2" } },
    });
    const projection = await projectInteractions(compiled, {
      run: { interaction: compiled.handles.run, modes: ["direct"] },
    });
    const result = await bindSurface(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (result.status !== "bound") throw new Error("expected bound");
    const context: Context = { marker: {} };
    await expect(result.binding.connect().call(projection.handles.run, context))
      .resolves.toEqual({ ok: true });
    expect(seen).toEqual([context]);
  });
});
