import { requestContext } from "../../../lib/demo-request";
import { readActivity } from "../../../lib/activity";
import { binding, documentCaller, projection } from "../../../lib/boundary";

export async function GET(request: Request) {
  let context;
  try { context = requestContext(request); } catch { return Response.json({ error: "Choose a demo session." }, { status: 401 }); }
  const document = await documentCaller(() => context).read.call(projection.handles.get, { id: "doc-1" });
  return Response.json({ events: await readActivity(), revision: document.revision,
    bindingDigest: binding.manifest.bindingDigest, projectionDigest: binding.manifest.projectionDigest,
    interactions: binding.manifest.interactions.map(({ interactionId, mode }) => ({ interactionId, mode })),
  }, { headers: { "cache-control": "no-store" } });
}
