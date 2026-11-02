import { agentBoundaryHandler, browserAgentContextFromRequest } from "../../../../lib/agent-entry";


export async function GET(request: Request) {
  try { browserAgentContextFromRequest(request); return await agentBoundaryHandler(request); }
  catch { return Response.json({ error: "A same-origin Folio session is required." }, { status: 403 }); }
}

export async function POST(request: Request) {
  try { browserAgentContextFromRequest(request); return await agentBoundaryHandler(request); }
  catch { return Response.json({ error: "A same-origin Folio session is required." }, { status: 403 }); }
}
