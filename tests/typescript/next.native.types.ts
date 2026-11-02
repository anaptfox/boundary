import type { Caller, InteractionDefinition } from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";
import { createNextServerCaller } from "@foxworth/boundary/frameworks/next";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { createAdapterFixture } from "./helpers/adapter";

async function nextNativeTypes() {
  const fixture = await createAdapterFixture();
  const { caller } = await fixture.connect({ call: ["list", "create"], propose: ["create"] });
  const next = createNextServerCaller({
    caller,
    context: () => ({ role: "owner" as const }),
  });

  const rows: Promise<Array<{ id: number; title: string }>> = next.read.list();
  const created: Promise<{ id: number; title: string }> = next.action.create({ title: "typed" });
  const proposal: Promise<JsonValue> = next.action.propose.create({ title: "typed" });
  void rows;
  void created;
  void proposal;

  // @ts-expect-error zero-input direct reads accept no input
  await next.read.list({});
  // @ts-expect-error one-input direct actions require input
  await next.action.create();
  // @ts-expect-error a call-only alias has no proposal
  await next.action.propose.list();
  // @ts-expect-error an unselected alias is absent
  await next.action.hidden();
}

void nextNativeTypes;

type Todo = Readonly<{ id: number; title: string }>;
type ListDefinition = InteractionDefinition<"todos.list", null, readonly Todo[], Readonly<Record<string, never>>, 0>;
type CreateDefinition = InteractionDefinition<"todos.create", Readonly<{ title: string }>, Todo, Readonly<Record<string, never>>, 1>;
type Definitions = Readonly<{ list: ListDefinition; create: CreateDefinition; proposal: CreateDefinition }>;
declare const typedCaller: Caller<Definitions, "list" | "create", "create" | "proposal", Readonly<{ actor: string }>>;

const typedNext = createNextServerCaller({
  caller: typedCaller,
  context: () => ({ actor: "server" }),
});
const typedRows: Promise<readonly Todo[]> = typedNext.read.list();
const typedCreate: Promise<Todo> = typedNext.action.create({ title: "typed" });
const typedProposal: Promise<JsonValue> = typedNext.action.propose.proposal({ title: "typed" });
void typedRows;
void typedCreate;
void typedProposal;

// @ts-expect-error a propose-only alias has no direct action
typedNext.action.proposal({ title: "typed" });
// @ts-expect-error a call-only alias has no proposal
typedNext.action.propose.list();
// @ts-expect-error zero-input read accepts no input
typedNext.read.list({});
// @ts-expect-error one-input action requires input
typedNext.action.create();

// A direct-only caller must infer its selected map too. Mixed-mode fixtures
// alone can hide a declaration consumer that accidentally requires propose.
declare const directCaller: Caller<Definitions, "list", never, Readonly<{ actor: string }>>;
const directNext = createNextServerCaller({
  caller: directCaller,
  context: () => ({ actor: "server" }),
});
const directRows: Promise<readonly Todo[]> = directNext.read.list();
void directRows;
// @ts-expect-error a direct-only caller does not select this mutation
directNext.action.create({ title: "unselected" });
// @ts-expect-error a direct-only caller selects no proposal
directNext.action.propose.list();
createProtocolHandler({
  caller: directCaller,
  path: "/boundary",
  context: () => ({ actor: "server" }),
});
