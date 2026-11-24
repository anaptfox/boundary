import { bindProjection, projectInteractions } from "@foxworth/boundary";
import type {
  InteractionDefinition,
  InteractionHandle,
  ProjectedInteractionHandle,
  ProjectionBinding,
} from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { createAdapterFixture } from "./helpers/adapter";

async function nextNativeTypes() {
  const fixture = await createAdapterFixture();
  const projection = projectInteractions(fixture.compiled, {
    list: { interaction: fixture.compiled.handles.list, modes: ["direct"] },
    create: { interaction: fixture.compiled.handles.create, modes: ["direct", "request"] },
    proposalOnly: { interaction: fixture.compiled.handles.create, modes: ["request"] },
  });
  const bound = bindProjection(projection, fixture.installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (bound.status !== "bound") return;
  const next = createNextServerCaller({
    binding: bound.binding,
    context: () => ({ role: "owner" as const }),
  });

  const rows: Promise<Array<{ id: number; title: string }>> = next.read.call(
    projection.handles.list,
  );
  const created: Promise<{ id: number; title: string }> = next.action.call(
    projection.handles.create,
    { title: "typed" },
  );
  const proposal: Promise<JsonValue> = next.action.request(
    projection.handles.proposalOnly,
    { title: "typed" },
  );
  void rows;
  void created;
  void proposal;

  // @ts-expect-error zero-input direct reads accept no input
  await next.read.call(projection.handles.list, {});
  // @ts-expect-error one-input direct actions require input
  await next.action.call(projection.handles.create);
  // @ts-expect-error request requires a selected request mode
  await next.action.request(projection.handles.list);
  // @ts-expect-error direct action requires a selected direct mode
  await next.action.call(projection.handles.proposalOnly, { title: "typed" });
}

void nextNativeTypes;

type Todo = Readonly<{ id: number; title: string }>;
type ListDefinition = InteractionDefinition<"todos.list", null, readonly Todo[], Readonly<Record<string, never>>, 0>;
type CreateDefinition = InteractionDefinition<"todos.create", Readonly<{ title: string }>, Todo, Readonly<Record<string, never>>, 1>;
type ListHandle = ProjectedInteractionHandle<InteractionHandle<ListDefinition>, readonly ["direct"]>;
type CreateHandle = ProjectedInteractionHandle<InteractionHandle<CreateDefinition>, readonly ["direct", "request"]>;
type ProposalOnlyHandle = ProjectedInteractionHandle<
  InteractionHandle<CreateDefinition>,
  readonly ["request"],
  Readonly<{ proposalId: string }>
>;
declare const typedBinding: ProjectionBinding<Readonly<{
  list: ListHandle;
  create: CreateHandle;
  proposal: ProposalOnlyHandle;
}>, Readonly<{ actor: string }>>;
declare const list: ListHandle;
declare const create: CreateHandle;
declare const proposalOnly: ProposalOnlyHandle;

const typedNext = createNextServerCaller({
  binding: typedBinding,
  context: () => ({ actor: "server" }),
});
const typedRows: Promise<readonly Todo[]> = typedNext.read.call(list);
const typedCreate: Promise<Todo> = typedNext.action.call(create, { title: "typed" });
const typedProposal: Promise<Readonly<{ proposalId: string }>> = typedNext.action.request(
  proposalOnly,
  { title: "typed" },
);
void typedRows;
void typedCreate;
void typedProposal;

// @ts-expect-error direct call requires a selected direct mode
typedNext.action.call(proposalOnly, { title: "typed" });
// @ts-expect-error request requires a selected request mode
typedNext.action.request(list);
// @ts-expect-error zero-input read accepts no input
typedNext.read.call(list, {});
// @ts-expect-error one-input action requires input
typedNext.action.call(create);

// A direct-only Binding must infer its selected map too. Mixed-mode fixtures
// alone can hide a declaration consumer that accidentally requires request().
declare const directBinding: ProjectionBinding<Readonly<{ list: ListHandle }>, Readonly<{ actor: string }>>;
const directNext = createNextServerCaller({
  binding: directBinding,
  context: () => ({ actor: "server" }),
});
const directRows: Promise<readonly Todo[]> = directNext.read.call(list);
void directRows;
// @ts-expect-error a direct-only Binding does not select this mutation
directNext.action.call(create, { title: "unselected" });
// @ts-expect-error a direct-only Binding does not select request mode
directNext.action.request(list);
createProtocolHandler({
  binding: directBinding,
  path: "/boundary",
  context: () => ({ actor: "server" }),
});
