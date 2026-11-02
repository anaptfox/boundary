import type { JsonValue } from "@foxworth/boundary/program";
import type {
  AnyInteractionDefinition, DefinitionInput, DefinitionOutput, ImplementationMap, MaybePromise,
} from "../types";

export type ObservationValidation = "matching" | "changed" | "unavailable";
export type ObservedPoint<Value extends JsonValue> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>;
export type PointEvidence<Value extends JsonValue> = ObservedPoint<Value> & Readonly<{ token: JsonValue }>;
export type QueryEvidence<Value extends JsonValue> = Readonly<{ value: Value; token: JsonValue }>;
export type ReadObservation<Key extends JsonValue = JsonValue, Query extends JsonValue = JsonValue> =
  | Readonly<{ kind: "point"; key: Key; present: boolean; token: JsonValue }>
  | Readonly<{ kind: "query"; query: Query; token: JsonValue }>;

/** Host-owned immutable snapshot. Keys, descriptors, values and tokens are JSON
 * data owned by the capturing view. Tokens must cover presence/content, or the
 * complete query answer including membership, order and pagination. */
export interface ObservedSnapshot<Key extends JsonValue, Point extends JsonValue, Query extends JsonValue, Rows extends JsonValue> {
  read(key: Key): MaybePromise<PointEvidence<Point>>;
  query(query: Query): MaybePromise<QueryEvidence<Rows>>;
  validate(observation: ReadObservation<Key, Query>): MaybePromise<ObservationValidation>;
}

/** The host owns acquisition and holds one immutable snapshot until run settles. */
export interface ObservationSource<Context, Key extends JsonValue, Point extends JsonValue, Query extends JsonValue, Rows extends JsonValue> {
  withSnapshot<Result>(
    context: Context,
    scope: JsonValue,
    run: (snapshot: ObservedSnapshot<Key, Point, Query, Rows>) => Promise<Result>,
  ): Promise<Result>;
}

export interface ObservationView<Key extends JsonValue, Point extends JsonValue, Query extends JsonValue, Rows extends JsonValue> {
  read(key: Key): Promise<ObservedPoint<Point>>;
  query(query: Query): Promise<Rows>;
}

/** Private diagnostics only; failures cannot change execution truth. */
export type ObservedReadDiagnostic = Readonly<{
  reused: boolean;
  validations: number;
  observations: number;
  reason: "reuse-off" | "miss" | "matching" | "changed" | "unavailable";
}>;

export type ObservedReadOptions<
  Definition extends AnyInteractionDefinition, Context,
  Key extends JsonValue, Point extends JsonValue, Query extends JsonValue, Rows extends JsonValue,
> = Readonly<{
  snapshots: ObservationSource<Context, Key, Point, Query, Rows>;
  scope(context: Context): JsonValue;
  authorize(input: DefinitionInput<Definition>, context: Context): MaybePromise<void>;
  evaluate(
    input: DefinitionInput<Definition>,
    view: ObservationView<Key, Point, Query, Rows>,
    context: Context,
  ): MaybePromise<DefinitionOutput<Definition>>;
  reuse?: "off" | "validated";
  maxEntries?: number;
  diagnostic?(event: ObservedReadDiagnostic): MaybePromise<void>;
}>;

export type ObservedReadImplementation<Definition extends AnyInteractionDefinition, Context> =
  ImplementationMap<{ read: Definition }, Context>["read"];
