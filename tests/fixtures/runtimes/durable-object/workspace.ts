import type { HttpHandler } from "@foxworth/boundary/http";

/**
 * The application keeps the native Durable Object class. Boundary is one ordinary
 * handler field alongside its SQLite, RPC, alarms, WebSockets, and policy.
 */
export class WorkspaceComposition<State, Environment> {
  readonly #boundary: HttpHandler;

  constructor(
    readonly state: State,
    readonly environment: Environment,
    createProjectionHandler: (state: State, environment: Environment) => HttpHandler,
  ) {
    this.#boundary = createProjectionHandler(state, environment);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#boundary(request);
    } catch {
      return new Response("Internal Server Error", { status: 500 });
    }
  }
}

// The executable native class and SQLite proof are in ./worker.ts. It has no
// Boundary-owned lifecycle: the application directly composes its checked handler.
