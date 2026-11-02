// Handoff must not import Host: dependency direction runs Host -> Handoff, so
// each capability keeps one owner. Handoff therefore declares structural copies of the Binding
// shapes it consumes, and Host's types must keep satisfying them. These
// assertions are checked by `just typecheck`; the runtime test proves a live
// Host Binding executes through the structural seam.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
  type BindingInvocation,
  type ProjectionBinding,
  type ResolvedBindingInteraction,
} from "@foxworth/boundary";
import {
  createCheckedHandoff,
  createHandoffInvocation,
  type HandoffBindingInvocation,
  type HandoffExecutable,
  type HandoffResolvedInteraction,
} from "@foxworth/boundary/handoff";
import { portableSchema } from "@foxworth/boundary/program";

describe("Host Binding satisfies the Handoff structural seam", () => {
  it("keeps the copied shapes mutually assignable", () => {
    expectTypeOf<ProjectionBinding<any, any>>().toExtend<HandoffExecutable>();
    expectTypeOf<ResolvedBindingInteraction>().toExtend<HandoffResolvedInteraction>();
    expectTypeOf<HandoffResolvedInteraction>().toExtend<ResolvedBindingInteraction>();
    expectTypeOf<BindingInvocation>().toExtend<HandoffBindingInvocation>();
    expectTypeOf<HandoffBindingInvocation>().toExtend<BindingInvocation>();
  });

  it("executes a live Host Binding through the checked Handoff seam", async () => {
    const Text = portableSchema<string>({ type: "string" });
    const interactions = { echo: defineInteraction({ id: "seam.echo", input: Text, output: Text }) };
    const compiled = await compileInteractions(interactions);
    const implementations = implementInteractions(interactions, { echo: (value: string) => value });
    const { installation } = await installInteractions(compiled, {
      installationId: "seam:installation",
      implementations,
      realizationIds: { echo: { direct: "seam:echo:direct" } },
    });
    const projection = await projectInteractions(compiled, { echo: "direct" });
    const bound = await bindProjection(projection, installation, { admit: () => ({ decision: "allow" }) });
    if (bound.status !== "bound") throw new Error("fixture did not bind");
    const executable: HandoffExecutable = bound.binding;
    const handoff = await createCheckedHandoff(executable);
    const invocation = await createHandoffInvocation(bound.binding.manifest, "seam.echo", "direct", "hello");
    const outcome = await handoff.invoke(invocation, undefined);
    expect(outcome.certainty).toBe("completed");
    expect(outcome.result).toEqual({ kind: "returned", value: "hello" });
  });
});
