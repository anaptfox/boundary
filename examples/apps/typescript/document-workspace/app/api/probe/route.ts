import { z } from "zod";
import { boundedJson, requestContext } from "../../../lib/demo-request";
import { documentCaller, projection } from "../../../lib/boundary";
import { saveFailure } from "../../../lib/save-result";

/** Always-narrower probes: neither branch can produce a successful save. */
export async function POST(request: Request) {
  let context;
  let kind: "denied" | "stale";
  try {
    context = requestContext(request);
    kind = z.object({ kind: z.enum(["denied", "stale"]) }).strict().parse(await boundedJson(request)).kind;
  } catch { return Response.json({ error: "A same-origin demo session and valid probe are required." }, { status: 400 }); }
  const caller = documentCaller(() => kind === "denied" ? { ...context, canEdit: false } : context, undefined, kind === "denied" ? "read-only-probe" : "stale-probe");
  const document = await caller.read.get({ id: "doc-1" });
  // A strictly older revision can never become current through another save.
  // At revision 1, zero is rejected by input validation before any effect.
  const expectedRevision = kind === "stale" ? document.revision - 1 : document.revision;
  try {
    await caller.action.save({ id: document.id, title: document.title, body: document.body,
      ...(document.richText === undefined ? {} : { richText: document.richText }), expectedRevision });
    return Response.json({ status: "unexpected-success" }, { status: 500 });
  } catch (error) {
    return Response.json({ ...saveFailure(error, projection.handles.save), expectedRevision, probe: kind });
  }
}
