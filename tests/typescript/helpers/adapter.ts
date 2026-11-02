import { z } from "zod";
import { portableSchema } from "@foxworth/boundary/program";
import { declaredInteractionError, defineInteraction, surface, type Caller, type Surface, type SurfaceAlias } from "@foxworth/boundary";
import { bindSurface, compileInteractions, createCaller, implementInteractions, installInteractions, projectInteractions, type CompiledSurface, type HandleSelections } from "@foxworth/boundary/pipeline";
import { createControlRequestContributions } from "@foxworth/boundary/host/control";

export type AdapterContext = Readonly<{
  role: "owner" | "viewer";
  marker?: object;
}>;

const Todo = z.strictObject({ id: z.number().int(), title: z.string() });
const CreateInput = z.strictObject({
  title: z.string().min(1).meta({
    title: "What needs doing?",
    description: "A short next action.",
    role: "display",
    control: "line",
  }),
});
const Duplicate = z.strictObject({ title: z.string() });
const Preview = portableSchema<Readonly<{ title: string }>>({
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
});

export async function createAdapterFixture() {
  const rows: Array<{ id: number; title: string }> = [];
  const contexts: AdapterContext[] = [];
  const interactions = {
    list: defineInteraction({
      id: "todos.list",
      output: z.array(Todo),
      reads: ["todos"],
      changes: [],
      summary: "Todos",
      description: "Read the current todo collection.",
    }),
    create: defineInteraction({
      id: "todos.create",
      input: CreateInput,
      output: Todo,
      errors: { duplicate: Duplicate },
      reads: [],
      changes: ["todos"],
      summary: "Add",
      description: "Create one todo with a non-empty title.",
    }),
    explode: defineInteraction({
      id: "todos.explode",
      output: z.never(),
      reads: ["todos"],
      changes: [],
      description: "Throw an unexpected failure.",
    }),
    hidden: defineInteraction({
      id: "todos.hidden",
      output: z.literal("hidden"),
      reads: ["todos"],
      changes: [],
      description: "Not selected by caller projections.",
    }),
    untitled: defineInteraction({
      id: "todos.untitled",
      output: z.strictObject({ ok: z.boolean() }),
      reads: [],
      changes: [],
    }),
    invalidName: defineInteraction({
      id: "todos.create~v1",
      output: z.literal("versioned"),
      reads: ["todos"],
      changes: [],
      description: "Read the versioned todo representation.",
    }),
  } as const;
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, AdapterContext>(
    interactions,
    {
      list(context) {
        contexts.push(context);
        return [...rows];
      },
      create(input, context) {
        contexts.push(context);
        if (input.title === "duplicate") {
          throw declaredInteractionError(interactions.create, "duplicate", {
            title: input.title,
          });
        }
        const value = { id: rows.length + 1, title: input.title };
        rows.push(value);
        return value;
      },
      explode(context) {
        contexts.push(context);
        throw new Error("token=private-adapter-secret");
      },
      hidden: () => "hidden" as const,
      untitled: () => ({ ok: true }),
      invalidName: () => "versioned" as const,
    },
  );
  const controlDigest = `sha256:${"1".repeat(64)}` as const;
  const requests = createControlRequestContributions<
    typeof interactions,
    AdapterContext
  >(compiled, {
    create: {
      interaction: compiled.handles.create,
      controlDigest,
      previewSchema: Preview,
      request(input, context) {
        contexts.push(context);
        return { title: input.title };
      },
    },
  });
  const { installation } = await installInteractions<typeof interactions, AdapterContext>(
    compiled,
    {
      installationId: "installation:adapter-v1:1",
      implementations,
      requests,
      realizationIds: {
        list: { direct: "realization:list:1" },
        create: {
          direct: "realization:create:1",
          request: "realization:create-request:1",
        },
        explode: { direct: "realization:explode:1" },
        hidden: { direct: "realization:hidden:1" },
        untitled: { direct: "realization:untitled:1" },
        invalidName: { direct: "realization:invalid-name:1" },
      },
    },
  );

  async function bind<const Selections extends HandleSelections>(
    projection: CompiledSurface<Selections>,
  ) {
    const result = await bindSurface(projection, installation, {
      admit: ({ context }) =>
        context.role === "owner"
          ? { decision: "allow" }
          : { decision: "deny", reason: "owner only" },
    });
    if (result.status !== "bound") {
      throw new Error("adapter fixture Binding could not be realized");
    }
    return result.binding;
  }

  const admit = {
    admit: ({ context }: { context: AdapterContext }) =>
      context.role === "owner"
        ? ({ decision: "allow" } as const)
        : ({ decision: "deny", reason: "owner only" } as const),
  };

  /** Connect a selection of the fixture's interactions and return the adapter-ready caller. */
  async function connect<
    const Call extends SurfaceAlias<typeof interactions> = never,
    const Propose extends SurfaceAlias<typeof interactions> = never,
  >(selection: Readonly<{ call?: readonly Call[]; propose?: readonly Propose[] }>) {
    const selected: Surface<typeof interactions, Call, Propose> = surface(interactions, selection);
    const modes: Record<string, ("direct" | "request")[]> = {};
    for (const alias of selected.call) (modes[alias] ??= []).push("direct");
    for (const alias of selected.propose) (modes[alias] ??= []).push("request");
    const projection = await projectInteractions(compiled, Object.fromEntries(
      Object.entries(modes).map(([alias, selectedModes]) => [alias, { interaction: compiled.handles[alias as keyof typeof interactions], modes: selectedModes }]),
    ));
    const result = await bindSurface(projection, installation, admit);
    if (result.status !== "bound") {
      throw new Error("adapter fixture Binding could not be realized");
    }
    const caller = createCaller(result.binding) as unknown as Caller<typeof interactions, Call, Propose, AdapterContext>;
    return { caller, binding: result.binding, projection };
  }

  return {
    bind,
    connect,
    compiled,
    contexts,
    controlDigest,
    installation,
    interactions,
    rows,
  };
}
