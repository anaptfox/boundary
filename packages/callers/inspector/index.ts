import { createCheckedHandoff, createHandoffInvocation, validateHandoffResponse, validateProjectionBindingManifest, type HandoffExecutable, type HandoffInvocation, type HandoffOutcome } from "@foxworth/boundary/handoff";
import { normalizeJson, validateSchemaValue, type InteractionMode, type InvocationCertainty, type JsonValue, type ProjectionBindingManifest } from "@foxworth/boundary/program";

/** Transport is host-owned. Each invocation is one attempt and must not be retried. */
export interface InspectorTransport {
  manifest(): Promise<unknown>;
  invoke(invocation: HandoffInvocation): Promise<unknown>;
}

export async function createBindingInspectorTransport<Context>(binding: HandoffExecutable, context: () => Context | Promise<Context>): Promise<InspectorTransport> {
  const handoff = await createCheckedHandoff<Context>(binding);
  return { async manifest() { return handoff.manifest; }, async invoke(invocation) { return handoff.invoke(invocation, await context()); } };
}

export interface Inspector {
  setTransport(transport: InspectorTransport | null): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}

const css = `
:host{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:CanvasText}
*{box-sizing:border-box} .shell{background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 24%,Canvas);border-radius:10px;overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem;border-bottom:1px solid color-mix(in srgb,CanvasText 20%,Canvas)} h2,h3,p{margin:0} h2{font-size:1.1rem} h3{font-size:1rem} .sub{font-size:.85rem;margin-top:.2rem} .body{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(0,2fr);min-height:18rem} nav{padding:1rem;border-right:1px solid color-mix(in srgb,CanvasText 20%,Canvas)} main{padding:1rem;min-width:0} nav button{display:block;width:100%;text-align:left;margin:.3rem 0} button,select,textarea{font:inherit;color:inherit;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 40%,Canvas);border-radius:5px;padding:.5rem} button{cursor:pointer} button:hover:not(:disabled),button[aria-pressed=true]{background:color-mix(in srgb,CanvasText 12%,Canvas)} button:disabled{opacity:.55;cursor:not-allowed} :focus-visible{outline:3px solid Highlight;outline-offset:2px} label{display:block;font-weight:600;margin:.9rem 0 .3rem} textarea{width:100%;min-height:9rem;resize:vertical;font-family:ui-monospace,monospace} pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;padding:.7rem;background:color-mix(in srgb,CanvasText 6%,Canvas);border-radius:5px} details{margin:.8rem 0} summary{cursor:pointer;font-weight:600} .actions{display:flex;gap:.6rem;align-items:end;flex-wrap:wrap} .status{padding:.5rem 1rem;border-bottom:1px solid color-mix(in srgb,CanvasText 20%,Canvas)} .attempts{max-height:14rem;overflow:auto}.attempts details{margin:.3rem 0}.attempts section{margin:.4rem 0}[role=alert]{color:CanvasText;font-weight:600} @media(max-width:600px){.body{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid color-mix(in srgb,CanvasText 20%,Canvas)}}
`;

/** Mounts an isolated, keyboard-operable inspector. The host controls its lifetime. */
export function mountInspector(container: HTMLElement, options: { transport: InspectorTransport | null; colorScheme?: "light" | "dark" | "auto" }): Inspector {
  const doc = container.ownerDocument;
  const root = doc.createElement("div"); root.dataset.boundaryInspector = "";
  if (options.colorScheme && options.colorScheme !== "auto") root.style.colorScheme = options.colorScheme;
  const shadow = root.attachShadow({ mode: "open" });
  const style = doc.createElement("style"); style.textContent = css; shadow.appendChild(style);
  const shell = doc.createElement("section"); shell.className = "shell"; shell.setAttribute("aria-label", "Boundary interaction inspector"); shadow.appendChild(shell); container.appendChild(root);
  let transport = options.transport, manifest: ProjectionBindingManifest | null = null;
  let selected: string | null = null, epoch = 0, disposed = false, busy = false;
  let status = "Loading selected interactions…", outcome = "";
  // A small in-memory set of attempts survives view/transport changes. It is not
  // a journal; disposal ends the host-owned UI lifetime.
  const attempts: Array<{ invocation: HandoffInvocation; state: "pending" | "settled"; certainty: InvocationCertainty | null; result: HandoffOutcome | null; evidence: string }> = [];
  const attemptLimit = 20;
  let attemptsPanel: HTMLElement;
  function renderAttempts() {
    if (disposed || !attemptsPanel) return;
    attemptsPanel.replaceChildren();
    if (!attempts.length) return;
    const heading = node("h3", "Invocation attempts"); heading.setAttribute("aria-live", "polite"); attemptsPanel.appendChild(heading);
    for (const attempt of attempts) {
      const row = node("section");
      const state = attempt.state === "pending" ? "Pending" : attempt.certainty === "unknown" ? "Unknown" : "Settled";
      const details = node("details");
      details.appendChild(node("summary", `${attempt.invocation.interactionId} · ${attempt.invocation.mode} · ${state}`));
      const evidence = node("pre", JSON.stringify({ interactionId: attempt.invocation.interactionId, mode: attempt.invocation.mode, bindingDigest: attempt.invocation.bindingDigest, expectedContractDigest: attempt.invocation.expectedContractDigest, actualContractDigest: attempt.invocation.actualContractDigest, realizationId: attempt.invocation.realizationId, input: attempt.invocation.input, status: attempt.state, certainty: attempt.certainty, result: attempt.result, evidence: attempt.evidence }, null, 2), "inspector-attempt");
      details.appendChild(evidence); row.appendChild(details);
      if (attempt.state === "settled") {
        const remove = node("button", "Remove attempt record") as HTMLButtonElement;
        remove.type = "button"; remove.onclick = () => { attempts.splice(attempts.indexOf(attempt), 1); renderAttempts(); };
        row.appendChild(remove);
      }
      attemptsPanel.appendChild(row);
    }
    attemptsPanel.appendChild(node("p", "Removing a record does not reconcile an unknown outcome."));
  }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, testId?: string): HTMLElementTagNameMap[K] => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; if (testId) e.dataset.testid = testId; return e; };
  function render() {
    if (disposed) return;
    shell.replaceChildren();
    const header = node("header"), title = node("div"); title.appendChild(node("h2", "Interaction inspector")); title.appendChild(node("p", "Selected declarations do not grant permission."));
    const refresh = node("button", "Refresh", "inspector-refresh") as HTMLButtonElement; refresh.type = "button"; refresh.disabled = !transport || busy; refresh.onclick = () => { void load(); }; header.appendChild(title); header.appendChild(refresh); shell.appendChild(header);
    const stat = node("div", status, "inspector-status"); stat.className = "status"; stat.setAttribute("role", "status"); shell.appendChild(stat); attemptsPanel = node("div", undefined, "inspector-attempts"); attemptsPanel.className = "status attempts"; attemptsPanel.setAttribute("aria-live", "polite"); shell.appendChild(attemptsPanel); renderAttempts();
    const body = node("div"); body.className = "body"; const nav = node("nav", undefined, "inspector-interactions"); nav.setAttribute("aria-label", "Selected interactions"); const main = node("main"); body.appendChild(nav); body.appendChild(main); shell.appendChild(body);
    if (!manifest) { main.appendChild(node("p", transport ? "Waiting for a valid Binding." : "Connect a host transport to inspect a Binding.")); return; }
    const entries = [...new Map(manifest.interactions.map(item => [item.interactionId, item])).values()];
    if (!entries.length) { nav.appendChild(node("p", "No interactions selected.")); main.appendChild(node("p", "This Binding exposes no interactions.")); return; }
    for (const entry of entries) { const button = node("button", entry.alias, "inspector-interaction") as HTMLButtonElement; button.type = "button"; button.dataset.interactionId = entry.interactionId; button.setAttribute("aria-pressed", String(selected === entry.interactionId)); button.onclick = () => { epoch++; busy = false; selected = entry.interactionId; outcome = ""; render(); shadow.querySelector<HTMLButtonElement>(`[data-interaction-id="${entry.interactionId}"]`)?.focus(); }; nav.appendChild(button); }
    const entry = entries.find(item => item.interactionId === selected); if (!entry) { main.appendChild(node("p", "Choose an interaction to inspect its contract.")); return; }
    const expected = manifest.expectedProgram.interactions.find(item => item.contract.id === entry.interactionId)!;
    const actual = manifest.actualProgram.interactions.find(item => item.contract.id === entry.interactionId)!;
    main.appendChild(node("h3", entry.alias)); main.appendChild(node("p", entry.interactionId));
    if (expected.docs.summary) main.appendChild(node("p", expected.docs.summary));
    const details = node("details"); details.appendChild(node("summary", "Contract and identity")); const contract = node("pre", "", "inspector-contract"); details.appendChild(contract); main.appendChild(details);
    const form = node("form") as HTMLFormElement; const inputLabel = node("label", "JSON input") as HTMLLabelElement; inputLabel.htmlFor = "input"; const input = node("textarea", undefined, "inspector-input") as HTMLTextAreaElement; input.id = "input"; input.value = entry.inputArity === 0 ? "null" : "{}"; input.spellcheck = false; form.appendChild(inputLabel); form.appendChild(input);
    const actions = node("div"); actions.className = "actions"; const modeBox = node("div"), label = node("label", "Mode") as HTMLLabelElement; label.htmlFor = "mode"; const mode = node("select", undefined, "inspector-mode") as HTMLSelectElement; mode.id = "mode"; for (const item of manifest.interactions.filter(item => item.interactionId === entry.interactionId)) { const option = node("option", item.mode === "request" ? "Request proposal" : "Direct execution") as HTMLOptionElement; option.value = item.mode; mode.appendChild(option); } const updateContract = () => { const selectedMode = currentInteractions.find(item => item.mode === mode.value)!; contract.textContent = JSON.stringify({ bindingDigest: currentBinding.bindingDigest, installationId: currentBinding.installationId, installationDigest: currentBinding.installationDigest, projectionDigest: currentBinding.projectionDigest, expectedProgramDigest: currentBinding.expectedProgramDigest, actualProgramDigest: currentBinding.actualProgramDigest, selectedMode, expected: expected.contract, actual: actual.contract }, null, 2); }; const currentBinding = manifest; const currentInteractions = currentBinding.interactions.filter(item => item.interactionId === entry.interactionId); mode.onchange = updateContract; updateContract(); modeBox.appendChild(label); modeBox.appendChild(mode); const invoke = node("button", "Invoke", "inspector-invoke") as HTMLButtonElement; invoke.type = "submit"; invoke.disabled = busy; actions.appendChild(modeBox); actions.appendChild(invoke); form.appendChild(actions);
    const output = node("pre", outcome || "No invocation yet.", "inspector-outcome"); output.setAttribute("aria-live", "polite"); form.appendChild(output); main.appendChild(form);
    form.onsubmit = event => { event.preventDefault(); if (busy || !transport || !manifest) return; if (attempts.length >= attemptLimit) { output.textContent = "Attempt record limit reached. Remove a settled record before invoking."; return; } const currentTransport = transport, currentManifest = manifest, token = epoch; let value: JsonValue; try { value = normalizeJson(JSON.parse(input.value), "input"); } catch { output.textContent = "Invalid JSON. Correct the input before invoking."; output.setAttribute("role", "alert"); return; }
      const issues = [...validateSchemaValue(expected.contract.inputSchema, value, "input"), ...validateSchemaValue(actual.contract.inputSchema, value, "input")]; if (entry.inputArity === 0 && value !== null) issues.push({ path: "input", message: "This interaction requires null." }); if (issues.length) { output.textContent = `Invalid input; no invocation sent.\n${issues.map(issue => `${issue.path}: ${issue.message}`).join("\n")}`; output.setAttribute("role", "alert"); return; }
      busy = true; invoke.disabled = true; refresh.disabled = true; output.textContent = "Invoking…";
      void (async () => {
        let attempt: (typeof attempts)[number] | undefined;
        try {
          const invocation = await createHandoffInvocation(currentManifest, entry.interactionId, mode.value as InteractionMode, value);
          if (disposed || epoch !== token) return;
          if (attempts.length >= attemptLimit) { outcome = "Attempt record limit reached. Remove a settled record before invoking."; return; }
          attempt = { invocation, state: "pending", certainty: null, result: null, evidence: "Pending: the attempt was sent; its outcome is not yet known." };
          attempts.push(attempt); renderAttempts();
          const raw = await currentTransport.invoke(invocation);
          const result = await validateHandoffResponse(currentManifest, invocation, raw);
          attempt.state = "settled"; attempt.certainty = result.certainty; attempt.result = result; attempt.evidence = JSON.stringify(result, null, 2);
          if (!disposed && epoch === token) outcome = attempt.evidence;
        } catch {
          if (attempt) { attempt.state = "settled"; attempt.certainty = "unknown"; attempt.evidence = "Outcome unknown: the transport or response could not establish what happened. Reconcile before considering another invocation."; }
          if (!disposed && epoch === token) outcome = attempt?.evidence ?? "Invocation could not be prepared; no invocation was sent.";
        } finally {
          if (!disposed) {
            renderAttempts();
            if (epoch === token) { busy = false; output.textContent = outcome; invoke.disabled = false; refresh.disabled = false; }
          }
        }
      })();
    };
  }
  async function load() { const token = ++epoch; manifest = null; selected = null; outcome = ""; busy = false; if (!transport) { status = "Disconnected"; render(); return; } status = "Loading selected interactions…"; render(); try { const result = await transport.manifest(); const checked = validateProjectionBindingManifest(result); if (disposed || token !== epoch) return; manifest = checked; status = checked.interactions.length ? "Connected — selection is not authorization." : "Connected — no interactions selected."; } catch { if (disposed || token !== epoch) return; status = "Unable to load a valid Binding. Check the connection and refresh."; } render(); }
  render(); void load();
  return { async setTransport(next) { transport = next; await load(); }, refresh: load, dispose() { if (disposed) return; disposed = true; epoch++; root.remove(); } };
}
