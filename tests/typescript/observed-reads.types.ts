import { defineInteraction } from "@foxworth/boundary";
import { implementInteractions } from "@foxworth/boundary/pipeline";
import { portableSchema } from "@foxworth/boundary/program";
import { observedRead, type ObservationSource } from "@foxworth/boundary/observations";

type Context = { tenant: string };
declare const snapshots: ObservationSource<Context, string, number, { prefix: string }, readonly number[]>;
const definitions = {
  get: defineInteraction({ id: "get", input: portableSchema<{ key: string }>({ type: "object", properties: { key: { type: "string" } }, required: ["key"] }),
    output: portableSchema<number>({ type: "number" }), reads: ["numbers"] }),
};
const implementation = observedRead(definitions.get, {
  snapshots,
  scope: context => ({ tenant: context.tenant }),
  authorize(input, context) { input.key satisfies string; context.tenant satisfies string; },
  async evaluate(input, view) {
    const point = await view.read(input.key);
    if (point.kind === "present") point.value satisfies number;
    const rows = await view.query({ prefix: input.key });
    rows satisfies readonly number[];
    // @ts-expect-error query descriptors come from the source type
    await view.query({ wrong: true });
    return point.kind === "present" ? point.value : 0;
  },
});
implementInteractions<typeof definitions, Context>(definitions, { get: implementation });
observedRead(definitions.get, {
  snapshots, scope: () => null, authorize() {},
  // @ts-expect-error the evaluator must return the declared output
  evaluate: () => "wrong",
});

// The TypeScript capture path owns JSON data, including observed values.
// @ts-expect-error Date point values cannot cross the JSON snapshot boundary
type DatePointSource = ObservationSource<Context, string, Date, { prefix: string }, readonly number[]>;
// @ts-expect-error Date query results cannot cross the JSON snapshot boundary
type DateRowsSource = ObservationSource<Context, string, number, { prefix: string }, readonly Date[]>;
