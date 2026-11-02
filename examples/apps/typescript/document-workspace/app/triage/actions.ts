"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { delegateInvestigation, triageCaller, type TriageContext } from "../../lib/triage-boundary";

function field(form: FormData, name: string) {
  const value = form.get(name);
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}
async function context(actor: TriageContext["actor"]): Promise<TriageContext> {
  const tenant = (await cookies()).get("boundary_triage_tenant")?.value;
  if (tenant !== "acme" && tenant !== "harbor") {
    throw new Error("choose a tenant before submitting triage work");
  }
  return actor === "reviewer"
    ? { tenant, actor, reviewer: "Local designated reviewer" }
    : { tenant, actor };
}
function finish(notice: string): never {
  revalidatePath("/triage");
  redirect(`/triage?notice=${notice}`);
}
export async function createTicket(form: FormData) {
  try {
    await triageCaller(() => context("human")).action.create({ title: field(form, "title"), customer: field(form, "customer") },
    );
  } catch {
    finish("uncertain");
  }
  finish("created");
}
export async function delegateTicket(form: FormData) {
  try {
    const current = await context("delegator");
    const agent = field(form, "agent");
    if (agent !== "signal-lens" && agent !== "runbook-reader") {
      throw new Error("unknown selected agent");
    }
    await delegateInvestigation(
      current.tenant,
      field(form, "id"),
      Number(field(form, "revision")),
      agent,
    );
  } catch {
    finish("uncertain");
  }
  finish("evidence-recorded");
}
export async function recordReview(form: FormData) {
  try {
    await triageCaller(() => context("reviewer")).action.review({
        id: field(form, "id"),
        expectedRevision: Number(field(form, "revision")),
        resolution: field(form, "resolution"),
      },
    );
  } catch {
    finish("uncertain");
  }
  finish("review-recorded");
}
export async function resolveTicket(form: FormData) {
  try {
    await triageCaller(() => context("reviewer")).action.resolve({ id: field(form, "id"), reviewId: field(form, "reviewId") },
    );
  } catch {
    finish("uncertain");
  }
  finish("resolved");
}
