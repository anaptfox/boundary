import { folioMcpHandler } from "../../../lib/agent-entry";

export function GET(request: Request) { return folioMcpHandler.fetch(request); }
export function POST(request: Request) { return folioMcpHandler.fetch(request); }
export function DELETE(request: Request) { return folioMcpHandler.fetch(request); }
