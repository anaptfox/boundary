import { bindNativeInteractions, bindProjection, compileInteractions, defineInteraction, installInteractions, projectInteractions, admitAll } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

async function authoring() {
  const definitions = {
    get: defineInteraction({ id: "typed.get", input: portableSchema<string>({ type: "string" }), output: portableSchema<number>({ type: "number" }) }),
    ready: defineInteraction({ id: "typed.ready", output: portableSchema<boolean>({ type: "boolean" }) }),
  };
  const compiled = compileInteractions(definitions);
  const targets = { get: { multiplier: 2 }, ready: { enabled: true } };
  const bindings = bindNativeInteractions(compiled, targets, {
    get({ input, target, outcomes }) {
      const text: string = input;
      const scale: number = target.multiplier;
      // @ts-expect-error the get alias cannot use the ready target
      target.enabled;
      // @ts-expect-error get returns number, not string
      outcomes.returned(text);
      return outcomes.returned(text.length * scale);
    },
    ready({ input, target, outcomes }) {
      const absent: null = input;
      return outcomes.returned(target.enabled && absent === null);
    },
  });
  const { installation } = installInteractions(compiled, { installationId: "types:installation", bindings, realizationIds: { get: { direct: "get:1" }, ready: { direct: "ready:1" } } });
  const projection = projectInteractions(compiled, { get: "direct", ready: "request" });
  // @ts-expect-error unknown shorthand aliases reject
  projectInteractions(compiled, { missing: "direct" });
  const selected = projectInteractions(compiled, { get: "direct" });
  // @ts-expect-error omitted handles stay omitted
  selected.handles.ready;
  const bound = bindProjection(selected, installation, { admit: admitAll });
  if (bound.status === "bound") {
    const n: number = await bound.binding.connect().call(selected.handles.get, "abc");
    // @ts-expect-error preserved input relation
    await bound.binding.connect().call(selected.handles.get, n);
    // @ts-expect-error request-only handle cannot be used as a direct handle
    await bound.binding.connect().call(projection.handles.ready);
  }
}
void authoring;
