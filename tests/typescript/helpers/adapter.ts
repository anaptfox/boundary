import { z } from "zod";
import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  implementInteractions,
  installInteractions,
  type Projection,
  type ProjectionSelections,
} from "@foxworth/boundary";
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

  async function bind<const Selections extends ProjectionSelections>(
    projection: Projection<Selections>,
  ) {
    const result = await bindProjection(projection, installation, {
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

  return {
    bind,
    compiled,
    contexts,
    controlDigest,
    installation,
    interactions,
    rows,
  };
}
