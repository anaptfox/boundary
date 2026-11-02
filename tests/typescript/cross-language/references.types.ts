import type { ProjectionClient } from "@foxworth/boundary/client";
import { references } from "./references";

// Compile-only assertions over types emitted from Rust, never executed.
export function checkGeneratedTypes(client: ProjectionClient) {
  const todo: Promise<{ readonly id: string; readonly title: string; readonly completed: boolean }> = client.call(references.create, { title: "typed" });
  // @ts-expect-error required native input cannot be omitted
  void client.call(references.create);
  // @ts-expect-error Rust declared title as a string
  void client.call(references.create, { title: 42 });
  // @ts-expect-error zero-input interactions take no placeholder
  void client.call(references.clearCompleted, {});
  // @ts-expect-error direct-only references cannot request Control
  void client.request(references.create, { title: "typed" });
  return todo;
}
