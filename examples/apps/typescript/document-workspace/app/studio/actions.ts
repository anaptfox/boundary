"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { studioCaller, studioProjection } from "../../lib/studio-boundary";
function field(form: FormData, name: string) {
  const value = form.get(name);
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}
function finish(notice: string): never {
  revalidatePath("/studio");
  redirect(`/studio?notice=${notice}`);
}
export async function createCandidate(form: FormData) {
  try {
    await studioCaller(() => ({ role: "maker" })).action.call(
      studioProjection.handles.create,
      { name: field(form, "name"), direction: field(form, "direction") },
    );
  } catch {
    finish("uncertain");
  }
  finish("created");
}
export async function editCandidate(form: FormData) {
  try {
    await studioCaller(() => ({ role: "maker" })).action.call(
      studioProjection.handles.edit,
      {
        id: field(form, "id"),
        expectedRevision: Number(field(form, "revision")),
        direction: field(form, "direction"),
      },
    );
  } catch {
    finish("uncertain");
  }
  finish("edited");
}
export async function chooseCandidate(form: FormData) {
  try {
    await studioCaller(() => ({ role: "reviewer" })).action.call(
      studioProjection.handles.choose,
      {
        id: field(form, "id"),
        expectedProjectRevision: Number(field(form, "projectRevision")),
        review: "designated-consequence-reviewed",
      },
    );
  } catch {
    finish("uncertain");
  }
  finish("chosen");
}
