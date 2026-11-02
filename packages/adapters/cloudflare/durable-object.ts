import type { HttpHandler } from "@foxworth/boundary/http";

export interface ProjectionDurableObjectInstance {
  fetch(request: Request): Promise<Response>;
}

export type ProjectionDurableObjectClass<State = unknown, Environment = unknown> =
  new (state: State, environment: Environment) => ProjectionDurableObjectInstance;

export type DurableObjectHandlerFactory<State = unknown, Environment = unknown> =
  (state: State, environment: Environment) => HttpHandler;

/**
 * Give each Durable Object instance its own prebuilt Projection HTTP handler.
 * State and environment stay in the application-owned factory.
 */
export function createProjectionDurableObject<
  State = unknown,
  Environment = unknown,
>(
  createHandler: DurableObjectHandlerFactory<State, Environment>,
): ProjectionDurableObjectClass<State, Environment> {
  return class ProjectionDurableObject {
    readonly #handler: HttpHandler;

    constructor(state: State, environment: Environment) {
      this.#handler = createHandler(state, environment);
    }

    async fetch(request: Request): Promise<Response> {
      try {
        return await this.#handler(request);
      } catch {
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  };
}
