import {
  createProjectionClient,
  type ClientTransport,
} from "@foxworth/boundary/client";
import {
  isDomainErrorFor,
  type InteractionDeclaredError,
  type RemoteInteractionDomainError,
} from "@foxworth/boundary/remote";
import type {
  InteractionDefinition,
  InteractionHandle,
  ProjectedInteractionHandle,
} from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";

type Todo = Readonly<{ id: number; title: string }>;
type ListDefinition = InteractionDefinition<
  "todos.list",
  null,
  readonly Todo[],
  Readonly<Record<string, never>>,
  0
>;
type CreateDefinition = InteractionDefinition<
  "todos.create",
  Readonly<{ title: string }>,
  Todo,
  Readonly<{ duplicate: Readonly<{ title: string }> }>,
  1
>;

declare const transport: ClientTransport;
declare const list: ProjectedInteractionHandle<
  InteractionHandle<ListDefinition>,
  readonly ["direct"]
>;
declare const create: ProjectedInteractionHandle<
  InteractionHandle<CreateDefinition>,
  readonly ["direct", "request"]
>;
type CreateProposal = Readonly<{ proposalId: string; title: string }>;
declare const generatedCreate: ProjectedInteractionHandle<
  InteractionHandle<CreateDefinition>,
  readonly ["request"],
  CreateProposal
>;

const client = createProjectionClient(transport);
const listed: Promise<readonly Todo[]> = client.call(list);
const created: Promise<Todo> = client.call(create, { title: "typed" });
const proposal = client.request(create, { title: "controlled" });
const genericProposal: Promise<JsonValue> = proposal;
const generatedProposal: Promise<CreateProposal> = client.request(
  generatedCreate,
  { title: "generated" },
);

void listed;
void created;
void proposal;
void genericProposal;
void generatedProposal;

// @ts-expect-error zero-input handles take no input argument
client.call(list, {});
// @ts-expect-error one-input handles require an argument
client.call(create);
// @ts-expect-error input stays carried by the projected handle type
client.call(create, { title: 42 });
// @ts-expect-error request uses the same one-input arity contract
client.request(create);

declare const createDomainError: RemoteInteractionDomainError<typeof create>;
const duplicate: "duplicate" = createDomainError.value.code;
const details: { readonly title: string } = createDomainError.value.details;
const declared: InteractionDeclaredError<typeof create> = createDomainError.value;
void duplicate;
void details;
void declared;

async function recoversDeclaredErrorFromCatch() {
  try {
    await client.call(create, { title: "typed" });
  } catch (error) {
    if (isDomainErrorFor(create, error)) {
      const caughtCode: "duplicate" = error.value.code;
      const caughtDetails: { readonly title: string } = error.value.details;
      void caughtCode;
      void caughtDetails;
    }
  }
}
void recoversDeclaredErrorFromCatch;
