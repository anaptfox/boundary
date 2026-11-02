import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createSurfaceClient } from "@foxworth/boundary/client";
import { portableSchema } from "@foxworth/boundary/program";
import { createControlCapabilities, digestControlRealization, targetForControl, type ControlHook } from "@foxworth/boundary/control";
import { MemoryJournal, TestClock, TestIds } from "@foxworth/boundary/control/testing";
import { Create, List, Todo } from "./native";
import { startRustTodo } from "./transport";
import scenarios from "./scenarios.v1.json";
import type { z } from "zod";

it("records a lost Rust response as uncertain and reconciles without a second create", async () => {
  const host = startRustTodo();
  try {
    const client = createSurfaceClient(host.transport);
    const manifest = await client.inspect();
    const interaction = manifest.interactions.find((entry) => entry.interactionId === "todos.create")!;
    const schema = portableSchema<{ title: string }>({ type: "object", properties: { title: { type: "string", minLength: 1 } }, required: ["title"], additionalProperties: false });
    const read = async () => List.parse(await client.callRaw("todos.list", { filter: "all" })).items;
    const hook: ControlHook<z.output<typeof Create>, z.output<typeof Todo>, { title: string }, { title: string }> = {
      realizationDigest: `sha256:${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")}`,
      state: schema, preview: schema,
      async plan({ input }) {
        if ((await read()).length !== 0) throw new Error("fixture requires an empty, single-writer host");
        return {
          subject: { kind: "todo-fixture", id: "single-writer" },
          baseline: { items: [] }, baselineSummary: "empty fixture",
          effects: [{ kind: "process", action: "create", resource: "todos" }],
          state: input, preview: input,
        };
      },
      async apply({ input }) { return Todo.parse(await client.callRaw("todos.create", input)); },
      async verify({ output }) {
        const rows = await read();
        return rows.length === 1 && rows[0]!.id === output.id && rows[0]!.title === output.title
          ? { ok: true, evidence: { observedId: output.id } }
          : { ok: false, message: "unexpected fixture state" };
      },
      async reconcile({ input }) {
        const rows = await read();
        return rows.length === 1 && rows[0]!.title === input.title
          ? { status: "completed", value: rows[0]! }
          : { status: "uncertain", reason: "fixture state does not prove this create" };
      },
    };
    const resolved = await digestControlRealization(
      { compileSchema: () => ({ contract: schema }) },
      { interactionId: interaction.interactionId, contractDigest: interaction.actualContractDigest }, hook,
    );
    // Caller-side Control owns this request policy; Rust exposes only direct
    // execution. These IDs do not claim a Rust request-mode contribution.
    const target = targetForControl(resolved, {
      bindingDigest: manifest.bindingDigest, projectionDigest: manifest.projectionDigest,
      installationId: manifest.installationId, installationDigest: manifest.installationDigest,
      expectedProgramDigest: manifest.expectedProgramDigest, actualProgramDigest: manifest.actualProgramDigest,
      programDigest: manifest.actualProgramDigest, interactionId: interaction.interactionId,
      expectedContractDigest: interaction.expectedContractDigest, contractDigest: interaction.actualContractDigest,
      requestRealizationId: "fixture/caller-create-policy/v1", executionRealizationId: interaction.realizationId,
    });
    const clock = new TestClock(100);
    const journal = new MemoryJournal(new TestIds("cross-language"));
    const capabilities = createControlCapabilities<string, undefined>({
      journal, clock, executor: { owner: "fixture" }, lease: { durationMs: scenarios.controlled.leaseDurationMs },
      policy: {
        identify: (actor) => actor,
        async preflight() { if ((await read()).length !== 0) throw new Error("fixture baseline changed"); },
        request: () => ({ allow: true }), approve: () => ({ allow: true }),
        grant: () => ({ allow: true }), execute: () => ({ allow: true }), reconcile: () => ({ allow: true }),
      },
    }, {
      inspect: () => ({ installationId: manifest.installationId, installationDigest: manifest.installationDigest, programDigest: manifest.actualProgramDigest }),
      resolve: (candidate) => {
        if (candidate.interactionId !== target.interactionId || candidate.controlDigest !== target.controlDigest) throw new Error("unknown fixture target");
        return { target, hook: resolved.hook, parseInput: Create.parse, parseState: Create.parse, parsePreview: Create.parse, parseOutput: Todo.parse };
      },
    }, { interactionIds: [target.interactionId], tenant: { kind: "todo-fixture", id: "single-writer" } });
    const proposal = await capabilities.requester.request({ actor: "requester", context: undefined, target, input: { title: scenarios.controlled.title } });
    await capabilities.admin.approve(proposal, "reviewer");
    const grant = await capabilities.admin.grant(proposal, "owner");
    host.dropNextResponse();
    const uncertain = await capabilities.admin.execute(grant, "executor", undefined);
    expect(uncertain).toMatchObject({ status: "uncertain" });
    if (uncertain.status !== "uncertain") throw new Error("lost result must remain uncertain");
    expect(await capabilities.admin.execute(grant, "executor", undefined)).toEqual(uncertain);
    expect(await capabilities.admin.reconcile(uncertain.attempt, "executor", undefined)).toEqual(uncertain);
    expect(await host.request({ kind: "stats" })).toMatchObject({ calls: { "todos.create": 1 }, rows: 1 });
    clock.advance(scenarios.controlled.leaseDurationMs + 1);
    const recovered = await capabilities.admin.reconcile(uncertain.attempt, "executor", undefined);
    expect(recovered).toMatchObject({ status: "completed", value: { id: "todo-1", title: scenarios.controlled.title } });
    expect(await capabilities.admin.execute(grant, "executor", undefined)).toEqual(recovered);
    expect(await host.request({ kind: "stats" })).toMatchObject({ calls: { "todos.create": 1 }, rows: 1 });
  } finally { await host.close(); }
});
