import {
  portableSchema,
  type JsonSchema,
  type JsonValue,
} from "@foxworth/boundary/program";
import { z } from "zod";
import {
  bindProjection,
  compileInteractions,
  composeCompiledInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  isDeclaredInteractionError,
  projectInteractions,
  type InteractionHandle,
  type InteractionInstallation,
  type ProjectionBinding,
  type ProjectedInteractionHandle,
  type RequestInteractionCaller,
  type SchemaAdapter,
} from "../../packages/core/host/index";

const zodInteractions = {
  create: defineInteraction({
    id: "zod.create",
    input: z.strictObject({ title: z.string(), rank: z.number().int() }),
    output: z.strictObject({ id: z.string(), title: z.string() }),
    errors: { duplicate: z.strictObject({ title: z.string() }) },
  }),
} as const;

implementInteractions(zodInteractions, {
  create(input) {
    input.title satisfies string;
    input.rank satisfies number;
    return { id: "1", title: input.title };
  },
});

implementInteractions(zodInteractions, {
  // @ts-expect-error Zod output inference rejects a mismatched realization
  create: () => ({ id: 1, title: "wrong" }),
});

const Message = portableSchema<{ readonly message: string }>({
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
});
const Text = portableSchema<string>({ type: "string" });
const interactions = {
  echo: defineInteraction({ id: "echo", input: Message, output: Text }),
  version: defineInteraction({ id: "version", output: Text }),
} as const;

implementInteractions(interactions, {
  echo: (input) => input.message,
  version: () => "1",
});

// @ts-expect-error implementation records are exhaustive
implementInteractions(interactions, { echo: (input) => input.message });

implementInteractions(interactions, {
  echo: (input) => input.message,
  version: () => "1",
  // @ts-expect-error implementation records reject extra aliases
  extra: () => "extra",
});

async function contextlessLifecycle() {
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions(interactions, {
    echo: (input) => input.message,
    version: () => "1",
  });
  const { installation } = installInteractions(compiled, {
    installationId: "deploy:types:1",
    implementations,
    realizationIds: {
      echo: { direct: "realization:echo:1" },
      version: { direct: "realization:version:1" },
    },
  });
  const projection = projectInteractions(compiled, {
    echo: { interaction: compiled.handles.echo, modes: ["direct"] },
    version: { interaction: compiled.handles.version, modes: ["direct"] },
  });
  const result = bindProjection(projection, installation, {
    admit: () => ({ decision: "allow" }),
  });
  if (result.status !== "bound") return;
  const caller = result.binding.connect();
  await caller.call(projection.handles.echo, { message: "hello" });
  await caller.call(projection.handles.version);
  // @ts-expect-error one-input interactions require input
  await caller.call(projection.handles.echo);
  // @ts-expect-error zero-input interactions do not accept an empty object
  await caller.call(projection.handles.version, {});
  // @ts-expect-error a direct-only caller exposes no request capability
  await caller.request(projection.handles.echo, { message: "hello" });
}

void contextlessLifecycle;

declare const narrowInstallation: InteractionInstallation<{ readonly actor: string }>;
declare const wideInstallation: InteractionInstallation<{
  readonly actor: string;
  readonly credential: string;
}>;
// @ts-expect-error Installation context is invariant; it cannot gain credentials.
const invalidWideInstallation: typeof wideInstallation = narrowInstallation;
// @ts-expect-error Installation context is invariant; it cannot discard credentials.
const invalidNarrowInstallation: typeof narrowInstallation = wideInstallation;
// @ts-expect-error execution values never carry host revocation authority.
narrowInstallation.revoke();

declare const narrowBinding: ProjectionBinding<any, { readonly actor: string }>;
declare const wideBinding: ProjectionBinding<any, {
  readonly actor: string;
  readonly credential: string;
}>;
// @ts-expect-error Binding context is invariant across adapter boundaries.
const invalidWideBinding: typeof wideBinding = narrowBinding;
// @ts-expect-error Binding context is invariant across adapter boundaries.
const invalidNarrowBinding: typeof narrowBinding = wideBinding;
// @ts-expect-error adapters cannot revoke a Binding they receive.
narrowBinding.revoke();

async function composedHandleTypes() {
  const left = compileInteractions({ echo: interactions.echo });
  const right = compileInteractions({ version: interactions.version });
  const composed = composeCompiledInteractions(left, right);
  composed.handles.echo.interactionId satisfies "echo";
  composed.handles.version.interactionId satisfies "version";
  // @ts-expect-error composition retains a closed handle record
  composed.handles.missing;
}

void composedHandleTypes;

type TypedSchema<Value extends JsonValue> = Readonly<{
  kind: "typed-test";
  contract: JsonSchema;
  "~standard": Readonly<{ types?: Readonly<{ output: Value }> }>;
}>;

declare const TypedInput: TypedSchema<{ readonly title: string }>;
declare const TypedOutput: TypedSchema<{
  readonly id: string;
  readonly title: string;
}>;
declare const typedSchemaAdapter: SchemaAdapter<TypedSchema<JsonValue>>;

const customSchemaInteractions = {
  create: defineInteraction({
    id: "typed-schema.create",
    input: TypedInput,
    output: TypedOutput,
  }),
} as const;

implementInteractions(customSchemaInteractions, {
  create(input) {
    input.title satisfies string;
    return { id: "1", title: input.title };
  },
});

void compileInteractions(customSchemaInteractions, {
  schemas: [typedSchemaAdapter],
});

type TypedRequestHandle = ProjectedInteractionHandle<
  InteractionHandle<typeof customSchemaInteractions.create>,
  readonly ["request"],
  { readonly proposalId: string }
>;

declare const typedRequestCaller: RequestInteractionCaller<
  Readonly<{ create: TypedRequestHandle }>,
  void
>;
declare const typedRequestHandle: TypedRequestHandle;

async function typedRequestResult() {
  const proposal = await typedRequestCaller.request(
    typedRequestHandle,
    { title: "hello" },
  );
  proposal.proposalId satisfies string;
}

void typedRequestResult;

type ZodCreateHandle = ProjectedInteractionHandle<
  InteractionHandle<typeof zodInteractions.create>,
  readonly ["direct"]
>;

function narrowsDeclaredErrors(
  error: unknown,
  handle: ZodCreateHandle,
) {
  if (isDeclaredInteractionError(error, handle, "duplicate")) {
    error.details.title satisfies string;
    // @ts-expect-error narrowed details retain the declared schema exactly
    error.details.missing;
  }

  // @ts-expect-error the guard accepts only codes declared by this interaction
  isDeclaredInteractionError(error, handle, "missing");
}

void narrowsDeclaredErrors;
