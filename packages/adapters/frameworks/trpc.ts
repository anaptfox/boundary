import type { AnyCaller, InteractionMode } from "@foxworth/boundary";
import { createCheckedHandoff } from "@foxworth/boundary/handoff";
import { initTRPC, type AnyRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { AdapterError, compileExposure, faultResult, invokePreparedInteraction, prepareExposedInteraction, sanitizedInternalResult, type InteractionInput, type RemoteCallResult, interactionKey, resolveSelection, seamOf, type AnySurfaceHandle, type InteractionSource, type SourceAliases, type SourceVerbs } from "@foxworth/boundary/remote";
import type { HttpHandler } from "@foxworth/boundary/http";

export type TrpcProcedureKind = "query" | "mutation";

export type TrpcProcedure = Readonly<{
  alias: string;
  handle: AnySurfaceHandle;
  /** Wire mode; `direct` is the caller's `call`, `request` its `propose`. */
  mode: InteractionMode;
  name: string;
  kind: TrpcProcedureKind;
}>;

const procedureDeclarations = new WeakSet<object>();
const PROCEDURE_NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u;

/** Declare one tRPC procedure over an alias the caller (or, offline, a CompiledSurface) selects. */
export function procedure<S extends InteractionSource, const Alias extends SourceAliases<S>>(
  source: S,
  alias: Alias,
  options: Readonly<{
    name?: string;
    kind: TrpcProcedureKind;
    /** `call` or `propose`; required when the alias is selected for both. */
    mode?: SourceVerbs<S, Alias>;
  }>,
): TrpcProcedure {
  const { handle, mode } = resolveSelection(source, alias, options.mode as never, "procedure");
  const name = options.name ?? handle.interactionId;
  if (!PROCEDURE_NAME.test(name)) {
    throw new AdapterError("INVALID_DECLARATION", "procedure.name", "procedure name must contain dot-separated identifier segments");
  }
  if (options.kind !== "query" && options.kind !== "mutation") {
    throw new AdapterError("INVALID_DECLARATION", "procedure.kind", "procedure kind must be query or mutation");
  }
  const declaration: TrpcProcedure = Object.freeze({ alias, handle, mode, name, kind: options.kind });
  procedureDeclarations.add(declaration);
  return declaration;
}

type RouterLeaf = Readonly<{ leaf: unknown }>;
interface RouterTree {
  [name: string]: RouterTree | RouterLeaf;
}

function parseProcedureInput(handle: AnySurfaceHandle, input: unknown): unknown {
  if (handle.inputArity === 0) {
    return input === undefined ? null : input;
  }
  return input;
}

function setLeaf(tree: RouterTree, path: string, leaf: unknown): void {
  const segments = path.split(".");
  let cursor = tree;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const existing = cursor[segment];
    if (last) {
      if (existing !== undefined) {
        throw new AdapterError("DUPLICATE_DECLARATION", `procedures.${path}`, `duplicate or colliding tRPC procedure: ${path}`);
      }
      cursor[segment] = Object.freeze({ leaf });
      return;
    }
    if (existing && "leaf" in existing) {
      throw new AdapterError("DUPLICATE_DECLARATION", `procedures.${path}`, `tRPC procedure collides with namespace: ${path}`);
    }
    cursor = (cursor[segment] ??= {}) as RouterTree;
  }
}

export type CreateTrpcRouterOptions<
  SurfaceContext,
  TrpcContext extends object,
> = Readonly<{
  caller: AnyCaller<SurfaceContext>;
  context(context: TrpcContext): SurfaceContext | Promise<SurfaceContext>;
  procedures: readonly TrpcProcedure[];
}>;

/** Create a router containing only explicitly declared procedures over one connected caller. */
export async function createTrpcRouter<
  SurfaceContext,
  TrpcContext extends object,
>(options: CreateTrpcRouterOptions<SurfaceContext, TrpcContext>): Promise<AnyRouter> {
  if (!options || typeof options.context !== "function") {
    throw new AdapterError("INVALID_DECLARATION", "createTrpcRouter.context", "context must resolve one invocation-scoped host value");
  }
  for (const [index, declaration] of options.procedures.entries()) {
    if (!procedureDeclarations.has(declaration)) {
      throw new AdapterError("INVALID_DECLARATION", `procedures[${index}]`, "procedures must be created by procedure()");
    }
  }
  let exposure: Awaited<ReturnType<typeof compileExposure>>;
  try {
    const handoff = await createCheckedHandoff(seamOf(options.caller, "createTrpcRouter.caller"));
    exposure = await compileExposure(handoff, options.procedures.map((entry) => ({
      handle: entry.handle,
      mode: entry.mode,
    })));
  } catch {
    throw new AdapterError(
      "INVALID_DECLARATION",
      "createTrpcRouter.procedures",
      "the tRPC router could not compile its declared exposure",
    );
  }
  const t = initTRPC.context<TrpcContext>().create();
  const tree: RouterTree = {};

  for (const declaration of options.procedures) {
    const exposed = exposure.interactions.get(interactionKey(
      declaration.handle.interactionId,
      declaration.mode,
    ));
    if (!exposed) {
      throw new AdapterError(
        "INVALID_DECLARATION",
        `procedures.${declaration.name}`,
        "the tRPC procedure is absent from the compiled exposure",
      );
    }
    const resolver = async (input: unknown, context: TrpcContext): Promise<RemoteCallResult> => {
      let prepared: Awaited<ReturnType<typeof prepareExposedInteraction>>;
      let hostContext: SurfaceContext;
      try {
        hostContext = await options.context(context);
        prepared = await prepareExposedInteraction({
          exposure,
          handle: declaration.handle,
          mode: declaration.mode,
          input,
        });
      } catch {
        return faultResult(exposure, exposed, "realization-failed");
      }
      try {
        return await invokePreparedInteraction(
          exposure,
          prepared.invocation,
          hostContext,
        );
      } catch {
        return sanitizedInternalResult(exposure, prepared.exposed);
      }
    };
    const base = t.procedure.input((input: unknown) =>
      parseProcedureInput(declaration.handle, input) as InteractionInput<typeof declaration.handle>
    );
    const leaf = declaration.kind === "query"
      ? base.query(({ input, ctx }) => resolver(input, ctx as unknown as TrpcContext))
      : base.mutation(({ input, ctx }) => resolver(input, ctx as unknown as TrpcContext));
    setLeaf(tree, declaration.name, leaf);
  }

  const build = (node: RouterTree): ReturnType<typeof t.router> =>
    t.router(Object.fromEntries(Object.entries(node).map(([name, childValue]) => {
      const child = childValue as RouterTree | RouterLeaf;
      return [name, "leaf" in child ? child.leaf : build(child)];
    })) as Parameters<typeof t.router>[0]);
  return build(tree);
}

export type CreateTrpcHandlerOptions<SurfaceContext> = Readonly<{
  caller: AnyCaller<SurfaceContext>;
  context(request: Request): SurfaceContext | Promise<SurfaceContext>;
  procedures: readonly TrpcProcedure[];
  endpoint?: string;
}>;

export function createTrpcHandler<SurfaceContext>(
  options: CreateTrpcHandlerOptions<SurfaceContext>,
): HttpHandler {
  const endpoint = options.endpoint ?? "/trpc";
  const router = createTrpcRouter({
    caller: options.caller,
    context: (context: { request: Request }) => options.context(context.request),
    procedures: options.procedures,
  });
  return async (request) => {
    let ready: AnyRouter;
    try {
      ready = await router;
    } catch {
      return Response.json({
        certainty: "not-started",
        error: {
          kind: "internal",
          code: "ADAPTER_INITIALIZATION_FAILED",
          message: "The tRPC adapter could not initialize its declared exposure.",
        },
      }, { status: 500 });
    }
    return fetchRequestHandler({
      endpoint,
      req: request,
      router: ready,
      createContext: () => ({ request }),
    });
  };
}
