import { z } from "zod";
import { declaredInteractionError, defineInteraction } from "@foxworth/boundary";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, projectInteractions, createCaller } from "@foxworth/boundary/pipeline";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import {
  type Investigator,
  readTriage,
  type TriageTenant,
  type TriageTicket,
  updateTriage,
} from "./triage-store";

const Investigator = z.enum(["signal-lens", "runbook-reader"]);
const conflict = z.strictObject({ actualRevision: z.number().int().positive() });
const reviewConflict = z.strictObject({ reviewId: z.string() });
const reviewMissing = z.strictObject({ reviewId: z.string() });
const Review = z.strictObject({
  id: z.string(),
  ticketId: z.string(),
  expectedRevision: z.number().int().positive(),
  resolution: z.string(),
  reviewer: z.string(),
});
const Finding = z.strictObject({
  id: z.string(),
  expectedRevision: z.number().int().positive(),
  investigator: Investigator,
  finding: z.string(),
  references: z.array(z.string()),
});
const Ticket = z.strictObject({
  id: z.string(),
  title: z.string(),
  customer: z.string(),
  status: z.enum(["new", "investigating", "resolved"]),
  revision: z.number().int().positive(),
  evidence: z.strictObject({
    investigator: Investigator,
    delegator: z.string(),
    finding: z.string(),
    references: z.array(z.string()),
    reviewedBy: z.string().optional(),
  }).optional(),
  resolution: z.string().optional(),
  pendingReview: Review.optional(),
});
export type TriageContext = Readonly<
  {
    tenant: TriageTenant;
    actor: "human" | "executor" | "delegator" | "reviewer";
    reviewer?: string;
  }
>;

function findingFor(
  ticket: Pick<TriageTicket, "id" | "title" | "customer" | "revision">,
  investigator: Investigator,
) {
  return {
    id: ticket.id,
    expectedRevision: ticket.revision,
    investigator,
    finding:
      `${investigator} read ticket ${ticket.id}: ${ticket.title} for ${ticket.customer}.`,
    references: [`ticket:${ticket.id}`, `revision:${ticket.revision}`],
  };
}
const interactions = {
  list: defineInteraction({
    id: "triage.tickets.list",
    input: z.strictObject({}),
    output: z.array(Ticket),
    reads: ["triage.tickets", "triage.reviews"],
    changes: [],
    description:
      "List the authenticated tenant's tickets and exact pending reviews.",
  }),
  inspect: defineInteraction({
    id: "triage.tickets.inspect",
    input: z.strictObject({
      id: z.string(),
      expectedRevision: z.number().int().positive(),
      investigator: Investigator,
    }),
    output: Finding,
    errors: { conflict },
    reads: ["triage.tickets"],
    changes: [],
    description:
      "Run a bounded local deterministic investigator against one stored ticket.",
  }),
  create: defineInteraction({
    id: "triage.tickets.create",
    input: z.strictObject({
      title: z.string().min(4).max(140),
      customer: z.string().min(2).max(80),
    }),
    output: Ticket,
    reads: [],
    changes: ["triage.tickets"],
    description: "Create a ticket in the authenticated tenant.",
  }),
  investigate: defineInteraction({
    id: "triage.tickets.investigate",
    input: Finding,
    output: Ticket,
    errors: { conflict },
    reads: ["triage.tickets"],
    changes: ["triage.tickets"],
    description:
      "Persist a delegator-accepted deterministic investigator finding.",
  }),
  review: defineInteraction({
    id: "triage.tickets.review",
    input: z.strictObject({
      id: z.string(),
      expectedRevision: z.number().int().positive(),
      resolution: z.string().min(8).max(400),
    }),
    output: Review,
    errors: { conflict, reviewConflict },
    reads: ["triage.tickets"],
    changes: ["triage.reviews"],
    description: "Record an app-owned CAS review.",
  }),
  resolve: defineInteraction({
    id: "triage.tickets.resolve",
    input: z.strictObject({ id: z.string(), reviewId: z.string() }),
    output: Ticket,
    errors: { conflict, reviewMissing },
    reads: ["triage.tickets", "triage.reviews"],
    changes: ["triage.tickets"],
    description: "Resolve only from an exact stored app-owned review.",
  }),
} as const;
const compiled = await compileInteractions(interactions);
const implementations = implementInteractions<typeof interactions, TriageContext>(
  interactions,
  {
    async list(_input, context) {
      const state = await readTriage(context.tenant);
      return state.tickets.map((ticket) => {
        const pendingReview = state.reviews.find((review) =>
          review.ticketId === ticket.id &&
          review.expectedRevision === ticket.revision
        );
        return pendingReview ? { ...ticket, pendingReview } : ticket;
      });
    },
    async inspect(input, context) {
      const ticket = (await readTriage(context.tenant)).tickets.find((value) =>
        value.id === input.id
      );
      if (!ticket) throw new Error("ticket not found");
      if (ticket.revision !== input.expectedRevision) {
        throw declaredInteractionError(interactions.inspect, "conflict", {
          actualRevision: ticket.revision,
        });
      }
      return findingFor(ticket, input.investigator);
    },
    async create(input, context) {
      return updateTriage(context.tenant, (state) => {
        const ticket: TriageTicket = {
          id: `${context.tenant}-${
            String(state.tickets.length + 401).padStart(3, "0")
          }`,
          title: input.title,
          customer: input.customer,
          status: "new",
          revision: 1,
        };
        state.tickets.unshift(ticket);
        return ticket;
      });
    },
    async investigate(input, context) {
      return updateTriage(context.tenant, (state) => {
        const ticket = state.tickets.find((value) => value.id === input.id);
        if (!ticket) throw new Error("ticket not found");
        if (ticket.revision !== input.expectedRevision) {
          throw declaredInteractionError(interactions.investigate, "conflict", {
            actualRevision: ticket.revision,
          });
        }
        const expected = findingFor(ticket, input.investigator);
        if (
          input.finding !== expected.finding ||
          input.references.join("|") !== expected.references.join("|")
        ) {
          throw new Error(
            "delegator finding does not match the bounded investigator read",
          );
        }
        const next = {
          ...ticket,
          status: "investigating" as const,
          revision: ticket.revision + 1,
          evidence: {
            investigator: input.investigator,
            delegator:
              "Delegator accepted the exact bounded investigator result.",
            finding: input.finding,
            references: input.references,
          },
        };
        state.tickets[state.tickets.indexOf(ticket)] = next;
        return next;
      });
    },
    async review(input, context) {
      return updateTriage(context.tenant, (state) => {
        const ticket = state.tickets.find((value) => value.id === input.id);
        if (!ticket) throw new Error("ticket not found");
        if (ticket.revision !== input.expectedRevision) {
          throw declaredInteractionError(interactions.review, "conflict", {
            actualRevision: ticket.revision,
          });
        }
        if (!ticket.evidence) {
          throw new Error("investigator evidence is required before review");
        }
        const review = {
          id: `review-${ticket.id}-${ticket.revision}`,
          ticketId: ticket.id,
          expectedRevision: ticket.revision,
          resolution: input.resolution,
          reviewer: context.reviewer ?? "local reviewer fixture",
        };
        const existing = state.reviews.find((value) => value.id === review.id);
        if (existing) {
          if (
            existing.resolution !== review.resolution ||
            existing.reviewer !== review.reviewer
          ) {
            throw declaredInteractionError(interactions.review, "reviewConflict", {
              reviewId: existing.id,
            });
          }
          return existing;
        }
        state.reviews.push(review);
        return review;
      });
    },
    async resolve(input, context) {
      return updateTriage(context.tenant, (state) => {
        const ticket = state.tickets.find((value) => value.id === input.id);
        const review = state.reviews.find((value) =>
          value.id === input.reviewId && value.ticketId === input.id
        );
        if (!ticket || !review) {
          throw declaredInteractionError(interactions.resolve, "reviewMissing", {
            reviewId: input.reviewId,
          });
        }
        if (ticket.revision !== review.expectedRevision) {
          throw declaredInteractionError(interactions.resolve, "conflict", {
            actualRevision: ticket.revision,
          });
        }
        const next = {
          ...ticket,
          status: "resolved" as const,
          revision: ticket.revision + 1,
          resolution: review.resolution,
          evidence: { ...ticket.evidence!, reviewedBy: review.reviewer },
        };
        state.tickets[state.tickets.indexOf(ticket)] = next;
        return next;
      });
    },
  },
);
const { installation } = await installInteractions(compiled, {
  installationId: "next-native:triage:3",
  implementations,
  realizationIds: {
    list: { direct: "triage-list-3" },
    inspect: { direct: "triage-inspect-3" },
    create: { direct: "triage-create-3" },
    investigate: { direct: "triage-investigate-3" },
    review: { direct: "triage-review-3" },
    resolve: { direct: "triage-resolve-3" },
  },
});
export const triageProjection = await projectInteractions(compiled, {
  list: { interaction: compiled.handles.list, modes: ["direct"] },
  inspect: { interaction: compiled.handles.inspect, modes: ["direct"] },
  create: { interaction: compiled.handles.create, modes: ["direct"] },
  investigate: { interaction: compiled.handles.investigate, modes: ["direct"] },
  review: { interaction: compiled.handles.review, modes: ["direct"] },
  resolve: { interaction: compiled.handles.resolve, modes: ["direct"] },
});
const bound = await bindSurface(triageProjection, installation, {
  admit: ({ context, handle }) => {
    const allowed = (context.actor === "human" &&
      ["triage.tickets.list", "triage.tickets.create"].includes(
        handle.interactionId,
      )) ||
      (context.actor === "executor" &&
        handle.interactionId === "triage.tickets.inspect") ||
      (context.actor === "delegator" &&
        handle.interactionId === "triage.tickets.investigate") ||
      (context.actor === "reviewer" &&
        ["triage.tickets.review", "triage.tickets.resolve"].includes(
          handle.interactionId,
        ));
    return allowed
      ? { decision: "allow" }
      : { decision: "deny", reason: "host policy keeps roles exact" };
  },
});
if (bound.status !== "bound") {
  throw new Error("triage binding was not realized");
}
const triageBinding = bound.binding;
export function triageCaller(
  context: () => TriageContext | Promise<TriageContext>,
) {
  return createNextServerCaller({ caller: createCaller(triageBinding), context });
}
export async function delegateInvestigation(
  tenant: TriageTenant,
  id: string,
  expectedRevision: number,
  investigator: Investigator,
) {
  const executor = triageCaller(() => ({ tenant, actor: "executor" as const }));
  const finding = await executor.read.inspect({
    id,
    expectedRevision,
    investigator,
  });
  return triageCaller(() => ({ tenant, actor: "delegator" as const })).action.investigate(finding);
}
