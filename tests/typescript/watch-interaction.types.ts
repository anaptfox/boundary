import type { InteractionDefinition } from "@foxworth/boundary";
import type { InteractionHandle, SurfaceHandle } from "@foxworth/boundary/pipeline";
import type { JsonValue } from "@foxworth/boundary/program";
import {
  watchInteraction,
  type InteractionRead,
} from "@foxworth/boundary/client/cache";
import type { SurfaceClient } from "@foxworth/boundary/client";

type Definition<Arity extends 0 | 1, Input extends JsonValue = JsonValue> =
  InteractionDefinition<
    string,
    Input,
    JsonValue,
    Readonly<Record<string, JsonValue>>,
    Arity
  >;

type Direct<Arity extends 0 | 1, Input extends JsonValue = JsonValue> =
  SurfaceHandle<InteractionHandle<Definition<Arity, Input>>, readonly ["direct"]>;

declare const client: SurfaceClient;
declare const zeroInputRead: Direct<0>;
declare const pageRead: Direct<1, Readonly<{ page: number }>>;
declare const requestOnly: SurfaceHandle<
  InteractionHandle<Definition<0>>,
  readonly ["request"]
>;

const zero: InteractionRead<typeof zeroInputRead> = watchInteraction(client, zeroInputRead);
const one: InteractionRead<typeof pageRead> = watchInteraction(client, pageRead, { page: 1 });
zero.getSnapshot().data satisfies JsonValue | undefined;
one.getSnapshot().data satisfies JsonValue | undefined;

// @ts-expect-error one-input reads require their declared input
watchInteraction(client, pageRead);
// @ts-expect-error zero-input reads do not accept a dummy input
watchInteraction(client, zeroInputRead, null);
// @ts-expect-error watchers require direct mode at the public type boundary
watchInteraction(client, requestOnly);
