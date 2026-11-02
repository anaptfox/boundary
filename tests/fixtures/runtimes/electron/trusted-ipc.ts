/**
 * Host-owned Electron application with two independently trusted workspaces.
 * The adapter supplies the IPC door; Boundary still owns the checked Binding and
 * the application owns workspace state, sender policy, and observation routing.
 */
import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection, compileInteractions, defineInteraction, implementInteractions,
  installInteractions, projectInteractions, type ProjectionBinding,
} from "@foxworth/boundary";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import {
  allowElectronSender, createProjectionElectronMain, type ElectronApis,
  type ElectronIpcSender, type ElectronIpcSenderFrame, type ProjectionElectronMain,
} from "@foxworth/boundary/electron";
import { createCaller } from "@foxworth/boundary/pipeline";

export type WorkspaceId = "alpha" | "beta";
export type WorkspaceContext = Readonly<{ workspaceId: WorkspaceId }>;

const Workspace = portableSchema<{ workspaceId: string; count: number }>({
  type: "object", properties: { workspaceId: { type: "string" }, count: { type: "integer" } },
  required: ["workspaceId", "count"], additionalProperties: false,
});
const Amount = portableSchema<{ amount: number }>({
  type: "object", properties: { amount: { type: "integer", minimum: 1 } },
  required: ["amount"], additionalProperties: false,
});
const interactions = {
  read: defineInteraction({ id: "workspace.read", output: Workspace, reads: ["workspace"], changes: [] }),
  increment: defineInteraction({ id: "workspace.increment", input: Amount, output: Workspace, reads: ["workspace"], changes: ["workspace"] }),
} as const;

export async function installTrustedProjection(input: {
  electron: ElectronApis;
  trustedWindows: Readonly<Record<WorkspaceId, Readonly<{ sender: ElectronIpcSender; frame: ElectronIpcSenderFrame }>>>;
  onObservation?(workspaceId: WorkspaceId, event: unknown): void;
}): Promise<Readonly<{ main: ProjectionElectronMain; binding: ProjectionBinding<any, WorkspaceContext>; state: ReadonlyMap<WorkspaceId, number>; revokeWindow(sender: ElectronIpcSender): void }>> {
  const state = new Map<WorkspaceId, number>([["alpha", 0], ["beta", 10]]);
  const compiled = await compileInteractions(interactions);
  const implementations = implementInteractions<typeof interactions, WorkspaceContext>(interactions, {
    read: (context) => ({ workspaceId: context.workspaceId, count: state.get(context.workspaceId)! }),
    increment: (input, context) => {
      const count = state.get(context.workspaceId)! + input.amount;
      state.set(context.workspaceId, count);
      return { workspaceId: context.workspaceId, count };
    },
  });
  const { installation } = await installInteractions(compiled, {
    installationId: "electron:workspaces:1", implementations,
    realizationIds: { read: { direct: "workspace:read:1" }, increment: { direct: "workspace:increment:1" } },
  });
  const projection = await projectInteractions(compiled, {
    read: { interaction: compiled.handles.read, modes: ["direct"] },
    increment: { interaction: compiled.handles.increment, modes: ["direct"] },
  });
  const bound = await bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
    observation: {
      correlate: (context) => ({ workspaceId: context.workspaceId }),
      publish: (event) => {
        const workspaceId = (event.correlation as { workspaceId?: WorkspaceId } | undefined)?.workspaceId;
        if (workspaceId) input.onObservation?.(workspaceId, event);
      },
    },
  });
  if (bound.status !== "bound") throw new Error("workspace projection did not bind");
  const trusted = Object.values(input.trustedWindows).map(({ sender, frame }) => ({ sender, frame, url: frame.url }));
  const active = new Set(trusted.map(({ sender }) => sender));
  const workspaceForSender = (sender: ElectronIpcSender): WorkspaceId | undefined =>
    Object.entries(input.trustedWindows).find(([, value]) => value.sender === sender)?.[0] as WorkspaceId | undefined;
  const handler = createProtocolHandler<WorkspaceContext>({
    caller: createCaller(bound.binding), path: "/_boundary",
    context: (request) => ({ workspaceId: request.headers.get("x-host-workspace") as WorkspaceId }),
  });
  const main = await createProjectionElectronMain<WorkspaceContext>({
    electron: input.electron, handler, port: false, scheme: "my-app-boundary", ipcChannel: "my-app-boundary",
    partition: "persist:my-app", openWindow: false,
    ipc: {
      validateSender: (event) => active.has(event.sender) && trusted.some((expected) => allowElectronSender(expected)(event)),
      createContext: (event) => {
        const workspaceId = workspaceForSender(event.sender);
        if (!workspaceId) throw new Error("untrusted workspace sender");
        return { workspaceId };
      },
      ipcHandler: (request, context) => {
        const headers = new Headers(request.headers);
        headers.set("x-host-workspace", context.workspaceId);
        return handler(new Request(request, { headers }));
      },
    },
  });
  return {
    main,
    binding: bound.binding,
    state,
    revokeWindow(sender: ElectronIpcSender) { active.delete(sender); },
  };
}
