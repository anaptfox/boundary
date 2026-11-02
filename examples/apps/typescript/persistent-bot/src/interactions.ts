import { defineInteraction } from "@foxworth/boundary";
import { z } from "zod";

export const applicationTask = z.strictObject({
  id: z.string(),
  title: z.string(),
  sourceKey: z.string(),
  state: z.literal("draft"),
});

/** The complete declared surface for this example.  The bot receives only list and create. */
export const interactions = {
  listTasks: defineInteraction({
    id: "persistent-bot.tasks.list",
    description: "List the application's saved task drafts.",
    output: z.array(applicationTask),
    reads: ["persistent-bot/tasks"],
    changes: [],
  }),
  createTask: defineInteraction({
    id: "persistent-bot.tasks.create",
    description: "Create one saved task draft for an exact delegated source key.",
    input: z.strictObject({
      title: z.string().min(1).max(240),
      sourceKey: z.string().min(1).max(160),
    }),
    output: applicationTask,
    errors: { duplicateSource: z.strictObject({ sourceKey: z.string() }) },
    reads: ["persistent-bot/tasks"],
    changes: ["persistent-bot/tasks"],
  }),
} as const;
