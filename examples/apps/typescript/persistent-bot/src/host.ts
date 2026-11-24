import {
  admitWhen,
  bindProjection,
  compileInteractions,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectAllDirect,
} from "@foxworth/boundary";
import { interactions } from "./interactions";
import type { BotStore } from "./storage";

type Actor = Readonly<{ id: "bot-planner"; jobId: string }>;

export async function createBotHost(store: BotStore) {
  const compiled = compileInteractions(interactions);
  const projection = projectAllDirect(compiled);
  const implementations = implementInteractions<typeof interactions, Actor>(interactions, {
    listTasks: () => store.listDrafts(),
    createTask: (input, actor) => store.createDraft(actor.jobId, input.title, input.sourceKey),
  });
  const installed = installInteractions<typeof interactions, Actor>(compiled, {
    installationId: "persistent-bot:local:v1",
    implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const bound = bindProjection(projection, installed.installation, {
    admit: admitWhen((actor: Actor) => actor?.id === "bot-planner"
      && store.job(actor.jobId)?.state === "running", "Requires a running host-owned delegation"),
  });
  if (bound.status !== "bound") {
    installed.controller.revoke();
    throw new Error("The persistent bot interaction surface did not bind");
  }
  return {
    caller: bound.binding.connect(),
    projection,
    close: () => installed.controller.revoke(),
  };
}
