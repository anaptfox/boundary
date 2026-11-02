import { expectTypeOf, it } from "vitest";
import type { WebMCP } from "webmcp-types";
import type { ModelContextPort, ModelContextRegisteredTool, ModelContextTool } from "../../packages/callers/webmcp/types";

it("accepts the installed browser WebMCP surface without a runtime wrapper", () => {
  expectTypeOf<WebMCP.ModelContext>().toExtend<ModelContextPort>();
  expectTypeOf<ModelContextTool>().toExtend<WebMCP.ModelContextTool>();
  expectTypeOf<WebMCP.RegisteredTool>().toExtend<ModelContextRegisteredTool>();
  expectTypeOf<Parameters<NonNullable<ModelContextPort["executeTool"]>>[1]>()
    .toEqualTypeOf<object | undefined>();
  expectTypeOf<ReturnType<NonNullable<ModelContextPort["executeTool"]>>>()
    .toEqualTypeOf<Promise<string>>();
});
