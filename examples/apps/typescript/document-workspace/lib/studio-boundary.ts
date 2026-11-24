import { z } from "zod";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { readStudio, type StudioCandidate, updateStudio } from "./studio-store";

const Candidate = z.strictObject({
  id: z.string(),
  name: z.string(),
  direction: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "chosen"]),
});
const State = z.strictObject({
  version: z.literal(1),
  projectRevision: z.number().int().positive(),
  chosenCandidateId: z.string().optional(),
  candidates: z.array(Candidate),
});
const conflict = z.strictObject({ actualRevision: z.number().int().positive() });
export type StudioContext = Readonly<{ role: "maker" | "reviewer" }>;
const interactions = {
  view: defineInteraction({
    id: "studio.candidates.view",
    input: z.strictObject({}),
    output: State,
    reads: ["studio.candidates"],
    changes: [],
    description: "Read the app-owned creative candidate board.",
  }),
  create: defineInteraction({
    id: "studio.candidates.create",
    input: z.strictObject({
      name: z.string().min(2).max(80),
      direction: z.string().min(12).max(500),
    }),
    output: Candidate,
    reads: [],
    changes: ["studio.candidates"],
    description: "Create one app-owned creative candidate.",
  }),
  edit: defineInteraction({
    id: "studio.candidates.edit",
    input: z.strictObject({
      id: z.string(),
      direction: z.string().min(12).max(500),
      expectedRevision: z.number().int().positive(),
    }),
    output: Candidate,
    errors: { conflict },
    reads: ["studio.candidates"],
    changes: ["studio.candidates"],
    description: "Edit an exact candidate revision.",
  }),
  compare: defineInteraction({
    id: "studio.candidates.compare",
    input: z.strictObject({ leftId: z.string(), rightId: z.string() }),
    output: z.strictObject({
      left: Candidate,
      right: Candidate,
      contrast: z.string(),
    }),
    reads: ["studio.candidates"],
    changes: [],
    description: "Compare two stored candidates without creating forks.",
  }),
  choose: defineInteraction({
    id: "studio.candidates.choose",
    input: z.strictObject({
      id: z.string(),
      expectedProjectRevision: z.number().int().positive(),
      review: z.literal("designated-consequence-reviewed"),
    }),
    output: State,
    errors: { conflict },
    reads: ["studio.candidates"],
    changes: ["studio.candidates"],
    description: "Choose one exact reviewed candidate.",
  }),
} as const;
const compiled = compileInteractions(interactions);
const implementations = implementInteractions<typeof interactions, StudioContext>(
  interactions,
  {
    async view() {
      return readStudio();
    },
    async create(input) {
      return updateStudio((state) => {
        const candidate: StudioCandidate = {
          id: `candidate-${state.candidates.length + 1}`,
          name: input.name,
          direction: input.direction,
          revision: 1,
          status: "draft",
        };
        state.candidates.unshift(candidate);
        state.projectRevision += 1;
        return candidate;
      });
    },
    async edit(input) {
      return updateStudio((state) => {
        const candidate = state.candidates.find((value) =>
          value.id === input.id
        );
        if (!candidate) throw new Error("candidate not found");
        if (
          candidate.revision !== input.expectedRevision
        ) {
          throw declaredInteractionError(interactions.edit, "conflict", {
            actualRevision: candidate.revision,
          });
        }
        const next = {
          ...candidate,
          direction: input.direction,
          revision: candidate.revision + 1,
        };
        state.candidates[state.candidates.indexOf(candidate)] = next;
        state.projectRevision += 1;
        return next;
      });
    },
    async compare(input) {
      const state = await readStudio();
      const left = state.candidates.find((candidate) =>
        candidate.id === input.leftId
      );
      const right = state.candidates.find((candidate) =>
        candidate.id === input.rightId
      );
      if (!left || !right || left.id === right.id) {
        throw new Error(
          "choose two distinct stored candidates",
        );
      }
      return {
        left,
        right,
        contrast: `${left.name} emphasizes ${left.direction.slice(0, 54)};
${right.name} emphasizes ${right.direction.slice(0, 54)}.`,
      };
    },
    async choose(input) {
      return updateStudio((state) => {
        if (
          state.projectRevision !== input.expectedProjectRevision
        ) {
          throw declaredInteractionError(interactions.choose, "conflict", {
            actualRevision: state.projectRevision,
          });
        }
        const candidate = state.candidates.find((value) =>
          value.id === input.id
        );
        if (!candidate) throw new Error("candidate not found");
        state.candidates = state.candidates.map((value) => ({
          ...value,
          status: value.id === candidate.id ? "chosen" : "draft",
        }));
        state.chosenCandidateId = candidate.id;
        state.projectRevision += 1;
        return state;
      });
    },
  },
);
const { installation } = installInteractions(compiled, {
  installationId: "next-native:studio:1",
  implementations,
  realizationIds: {
    view: { direct: "studio-view-1" },
    create: { direct: "studio-create-1" },
    edit: { direct: "studio-edit-1" },
    compare: { direct: "studio-compare-1" },
    choose: { direct: "studio-choose-1" },
  },
});
export const studioProjection = projectInteractions(compiled, {
  view: { interaction: compiled.handles.view, modes: ["direct"] },
  create: { interaction: compiled.handles.create, modes: ["direct"] },
  edit: { interaction: compiled.handles.edit, modes: ["direct"] },
  compare: { interaction: compiled.handles.compare, modes: ["direct"] },
  choose: { interaction: compiled.handles.choose, modes: ["direct"] },
});
const bound = bindProjection(studioProjection, installation, {
  admit: ({ context, handle }) => {
    const role = context.role;
    const allowed = (handle.interactionId === "studio.candidates.view" ||
      handle.interactionId === "studio.candidates.compare") ||
      (role === "maker" &&
        (handle.interactionId === "studio.candidates.create" ||
          handle.interactionId === "studio.candidates.edit")) ||
      (role === "reviewer" &&
        handle.interactionId === "studio.candidates.choose");
    return allowed ? { decision: "allow" } : {
      decision: "deny",
      reason:
        "host policy keeps the selection authority with the designated reviewer",
    };
  },
});
if (bound.status !== "bound") {
  throw new Error("studio binding was not realized");
}
const studioBinding = bound.binding;
export function studioCaller(context: () => StudioContext) {
  return createNextServerCaller({ binding: studioBinding, context });
}
