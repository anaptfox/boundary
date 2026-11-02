import { expect, it } from "vitest";
import { createSurfaceClient, pinSurfaceReferences } from "@foxworth/boundary/client";
import { references } from "./references";
import { startRustTodo } from "./transport";

it("pins generated TypeScript references and calls native Rust without redeclaring interactions", async () => {
  const host = startRustTodo();
  try {
    const client = createSurfaceClient(host.transport);
    const pinned = await pinSurfaceReferences(client, references);
    const created = await client.call(pinned.create, { title: "Generated from Rust" });
    expect(created).toEqual({ id: "todo-1", title: "Generated from Rust", completed: false });
    expect(await client.call(pinned.list, { filter: "all" })).toEqual({ items: [created] });
    expect(await client.call(pinned.setCompleted, { id: created.id, completed: true })).toMatchObject({ completed: true });
    expect(await client.call(pinned.clearCompleted)).toEqual({ count: "1" });
    await expect(pinSurfaceReferences(client, {
      ...references,
      create: { ...references.create, contractDigest: `sha256:${"0".repeat(64)}` as const },
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });
    expect(await host.request({ kind: "stats" })).toMatchObject({ calls: { "todos.create": 1 } });
  } finally { await host.close(); }
});
