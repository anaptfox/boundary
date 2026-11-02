// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { admitAll, bindProjection, compileInteractions, defineInteraction, implementInteractions, installInteractions, pickProjection, projectInteractions, restrictBinding } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";
import { createControlRequestContributions } from "../../packages/core/host/control";
import { createBindingInspectorTransport, mountInspector, type InspectorTransport } from "@foxworth/boundary/inspector";

const Input = portableSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false });
const Output = portableSchema<string>({ type: "string" });
async function fixture() {
  const definitions = { read: defineInteraction({ id: "test.read", input: Input, output: Output, reads: ["items"] }), hidden: defineInteraction({ id: "test.hidden", input: Input, output: Output, changes: ["items"] }) };
  const compiled = await compileInteractions(definitions); const calls: string[] = [];
  const { installation } = await installInteractions<typeof definitions, void>(compiled, { installationId: "test:inspector", implementations: implementInteractions<typeof definitions, void>(definitions, { read(input) { calls.push(input.value); return input.value; }, hidden(input) { calls.push(input.value); return input.value; } }), requests: createControlRequestContributions<typeof definitions, void>(compiled, { read: { interaction: compiled.handles.read, controlDigest: compiled.handles.read.contractDigest, previewSchema: Output, request(input) { return input.value; } } }), realizationIds: { read: { direct: "test:read", request: "test:request" }, hidden: { direct: "test:hidden" } } });
  const projection = await projectInteractions(compiled, { read: { interaction: compiled.handles.read, modes: ["direct", "request"] }, hidden: { interaction: compiled.handles.hidden, modes: ["direct"] } });
  const parent = await bindProjection(projection, installation, { admit: admitAll }); if (parent.status !== "bound") throw Error("not bound");
  const selected = await pickProjection(projection, "read"); const child = await restrictBinding(parent.binding, { projection: selected, admit: admitAll }); if (child.status !== "bound") throw Error("not bound");
  return { child, parent, calls, transport: await createBindingInspectorTransport(child.binding, () => undefined) };
}
async function settle() { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
function setup(transport: InspectorTransport | null) { const container = document.createElement("div"); document.body.appendChild(container); const inspector = mountInspector(container, { transport }); const root = container.firstElementChild!.shadowRoot!; const get = <T = Element>(id: string) => root.querySelector(`[data-testid="${id}"]`)! as unknown as T; return { container, inspector, root, get }; }
async function select(ui: ReturnType<typeof setup>) { await settle(); ui.get<HTMLButtonElement>("inspector-interaction").click(); }
function invoke(ui: ReturnType<typeof setup>, input: string, mode = "direct") { ui.get<HTMLTextAreaElement>("inspector-input").value = input; ui.get<HTMLSelectElement>("inspector-mode").value = mode; ui.get<HTMLFormElement>("inspector-input").closest("form")!.requestSubmit(); }

describe("inspector", () => {
  it("allows the host to select a color scheme", () => { const container = document.createElement("div"); const inspector = mountInspector(container, { transport: null, colorScheme: "dark" }); expect((container.firstElementChild as HTMLElement).style.colorScheme).toBe("dark"); inspector.dispose(); });
  it("shows only selected contracts and rejects invalid JSON and schema before dispatch", async () => { const f = await fixture(); const ui = setup(f.transport); await select(ui); expect(ui.root.textContent).not.toContain("test.hidden"); expect(ui.get("inspector-contract").textContent).toContain("test.read"); expect(ui.get("inspector-contract").textContent).toContain("test:read"); const selector = ui.get<HTMLSelectElement>("inspector-mode"); selector.value = "request"; selector.dispatchEvent(new Event("change")); expect(ui.get("inspector-contract").textContent).toContain("test:request"); expect(ui.get("inspector-contract").textContent).toContain("controlDigest"); selector.value = "direct"; invoke(ui, "{"); expect(ui.get("inspector-outcome").textContent).toContain("Invalid JSON"); invoke(ui, "{}"); expect(ui.get("inspector-outcome").textContent).toContain("no invocation sent"); invoke(ui, "1e400"); expect(ui.get("inspector-outcome").textContent).toContain("Invalid JSON"); expect(f.calls).toEqual([]); ui.inspector.dispose(); });
  it("distinguishes a request proposal from direct execution and observes inherited revocation", async () => { const f = await fixture(); const ui = setup(f.transport); await select(ui); invoke(ui, '{"value":"preview"}', "request"); await settle(); expect(ui.get("inspector-outcome").textContent).toContain('"proposed"'); expect(f.calls).toEqual([]); invoke(ui, '{"value":"run"}'); await settle(); expect(ui.get("inspector-outcome").textContent).toContain('"completed"'); expect(f.calls).toEqual(["run"]); f.parent.controller.revoke(); invoke(ui, '{"value":"blocked"}'); await settle(); expect(ui.get("inspector-outcome").textContent).toContain('"revoked"'); expect(f.calls).toEqual(["run"]); ui.inspector.dispose(); });
  it("does not mistake nested domain certainty for invocation certainty", async () => {
    const output = portableSchema<{ certainty: string }>({ type: "object", properties: { certainty: { type: "string" } }, required: ["certainty"], additionalProperties: false });
    const definitions = { read: defineInteraction({ id: "nested.read", input: Input, output, reads: ["items"] }) };
    const compiled = await compileInteractions(definitions);
    const { installation } = await installInteractions<typeof definitions, void>(compiled, { installationId: "nested:installation", implementations: implementInteractions<typeof definitions, void>(definitions, { read() { return { certainty: "unknown" }; } }), realizationIds: { read: { direct: "nested:read" } } });
    const projection = await projectInteractions(compiled, { read: { interaction: compiled.handles.read, modes: ["direct"] } });
    const bound = await bindProjection(projection, installation, { admit: admitAll }); if (bound.status !== "bound") throw Error("not bound");
    const ui = setup(await createBindingInspectorTransport(bound.binding, () => undefined)); await select(ui); invoke(ui, '{"value":"x"}'); await settle();
    expect(ui.root.querySelector("[data-testid=inspector-attempts] summary")?.textContent).toContain("Settled");
    expect(ui.root.querySelector("[data-testid=inspector-attempts] summary")?.textContent).not.toContain("Unknown");
    expect(ui.get("inspector-attempt").textContent).toContain('"certainty": "unknown"');
    expect(ui.get("inspector-outcome").textContent).toContain('"certainty": "completed"'); ui.inspector.dispose();
  });
  it("preserves unknown and does not retry a failed transport", async () => { const f = await fixture(); let calls = 0; const ui = setup({ manifest: f.transport.manifest, async invoke() { calls++; throw Error("connection lost"); } }); await select(ui); invoke(ui, '{"value":"x"}'); await settle(); expect(ui.get("inspector-outcome").textContent).toContain("Outcome unknown"); expect(calls).toBe(1); await ui.inspector.setTransport(null); expect(ui.get("inspector-attempt").textContent).toContain("unknown"); ui.inspector.dispose(); });
  it("retains pending attempts across disconnect and resolves the original attempt without overwriting a new view", async () => {
    const f = await fixture();
    let release!: () => void;
    let calls = 0;
    const transport: InspectorTransport = { manifest: f.transport.manifest, async invoke(invocation) { calls++; await new Promise<void>(resolve => { release = resolve; }); return f.transport.invoke(invocation); } };
    const ui = setup(transport); await select(ui);
    invoke(ui, '{"value":"original"}'); await settle();
    await ui.inspector.setTransport(null);
    expect(ui.get("inspector-status").textContent).toContain("Disconnected");
    expect(ui.get("inspector-attempt").textContent).toContain('"status": "pending"'); expect(ui.root.querySelector("[data-testid=inspector-attempts] summary")?.textContent).toContain("test.read · direct · Pending"); expect(ui.get("inspector-attempt").closest("details")?.open).toBe(false);
    expect(ui.get("inspector-attempt").textContent).toContain("original");
    await ui.inspector.setTransport(f.transport); ui.get<HTMLButtonElement>("inspector-interaction").click();
    expect(ui.get("inspector-outcome").textContent).toContain("No invocation yet");
    release(); await settle();
    expect(ui.get("inspector-attempt").textContent).toContain('completed');
    expect(ui.get("inspector-outcome").textContent).toContain("No invocation yet");
    expect(calls).toBe(1); ui.inspector.dispose();
  });
  it("retains unknown for a pending attempt when selection changes and transport fails", async () => {
    const f = await fixture(); let reject!: (error: Error) => void; let calls = 0;
    const ui = setup({ manifest: f.transport.manifest, invoke() { calls++; return new Promise((_resolve, fail) => { reject = fail; }); } });
    await select(ui); invoke(ui, '{"value":"lost"}'); await settle();
    ui.get<HTMLButtonElement>("inspector-interaction").click();
    expect(ui.get("inspector-attempt").textContent).toContain("pending");
    reject(Error("lost")); await settle();
    expect(ui.get("inspector-attempt").textContent).toContain("Outcome unknown");
    expect(ui.root.querySelector("[data-testid=inspector-attempts] summary")?.textContent).toContain("Unknown");
    expect(ui.get("inspector-attempt").textContent).toContain("lost");
    expect(ui.get("inspector-outcome").textContent).toContain("No invocation yet");
    expect(calls).toBe(1); ui.inspector.dispose();
  });
  it("ignores a stale manifest and a pending result after disposal", async () => { const f = await fixture(); let resolveManifest!: (value: unknown) => void; const pending: InspectorTransport = { manifest: () => new Promise(resolve => { resolveManifest = resolve; }), invoke: f.transport.invoke }; const ui = setup(pending); await ui.inspector.setTransport(f.transport); resolveManifest({}); await settle(); expect(ui.get("inspector-status").textContent).toContain("Connected"); ui.get<HTMLButtonElement>("inspector-interaction").click(); let resolveOutcome!: (value: unknown) => void; await ui.inspector.setTransport({ manifest: f.transport.manifest, invoke: () => new Promise(resolve => { resolveOutcome = resolve; }) }); ui.get<HTMLButtonElement>("inspector-interaction").click(); invoke(ui, '{"value":"pending"}'); await settle(); ui.inspector.dispose(); resolveOutcome({}); await settle(); expect(ui.container.childElementCount).toBe(0); });
});
