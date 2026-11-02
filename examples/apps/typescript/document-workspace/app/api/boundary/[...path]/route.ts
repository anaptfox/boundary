import { createProjectionHandlers } from "@foxworth/boundary/frameworks/next";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { demoContextFromCookie } from "../../../../lib/context";
import { caller } from "../../../../lib/boundary";
import { tracedContext } from "../../../../lib/activity";

const handler = createProtocolHandler({
  caller,
  path: "/api/boundary",
  context: (request) => tracedContext(demoContextFromCookie(request.headers.get("cookie")), "protocol"),
});

export const { GET, POST } = createProjectionHandlers(handler);
