import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publishExecutionEvidence } from "@foxworth/boundary";
import { validateExecutionEvidence } from "@foxworth/boundary/program";

type Vector = { name: string; patches: Array<{ path: string[]; value: unknown }>; valid: boolean };
const vectors = JSON.parse(readFileSync(new URL("../conformance/v1/execution-evidence.json", import.meta.url), "utf8")) as { version: number; base: unknown; cases: Vector[] };

function apply(vector: Vector): Record<string, unknown> {
  const value = structuredClone(vectors.base) as Record<string, unknown>;
  for (const patch of vector.patches) {
    let parent = value;
    for (const segment of patch.path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
    parent[patch.path.at(-1)!] = structuredClone(patch.value);
  }
  return value;
}

describe("ExecutionEvidence v1", () => {
  it.each(vectors.cases)("consumes independent shared law: $name", vector => {
    expect(vectors.version).toBe(1);
    const value = apply(vector);
    if (vector.valid) expect(validateExecutionEvidence(value)).toEqual(value);
    else expect(() => validateExecutionEvidence(value)).toThrow();
  });

  it("clones and freezes links without introducing subject facts", () => {
    const input = apply(vectors.cases[0]!);
    const evidence = validateExecutionEvidence(input);
    expect(evidence.subject).toBeUndefined();
    expect(evidence.parents).toBeUndefined();
    expect(Object.isFrozen(evidence.invocation.observation.reads)).toBe(true);
    (input.invocation as Record<string, unknown>).reference = { kind: "invocation", namespace: "changed", id: "changed" };
    expect(evidence.invocation.reference.namespace).toBe("owner-1");
  });

  it("rejects accessors without invoking them and bounds causal links", () => {
    let called = false;
    const accessor = Object.defineProperty(apply(vectors.cases[0]!), "subject", { enumerable: true, get: () => { called = true; return {}; } });
    expect(() => validateExecutionEvidence(accessor)).toThrow();
    expect(called).toBe(false);
    const input = apply(vectors.cases[0]!);
    input.parents = Array.from({ length: 129 }, (_, index) => ({ kind: "evidence", namespace: "owner-1", id: `earlier-${index}` }));
    expect(() => validateExecutionEvidence(input)).toThrow(/at most 128/);
  });

  it("explicit publication preserves completed invocation and uncertain subject through delivery failure", async () => {
    const input = apply(vectors.cases[1]!);
    let calls = 0;
    const result = await publishExecutionEvidence({ publish(evidence) {
      calls += 1;
      expect(evidence.invocation.observation.certainty).toBe("completed");
      expect(evidence.subject?.state).toBe("uncertain");
      throw new Error("delivery unavailable");
    } }, input);
    expect(result.status).toBe("delivery-failed");
    expect(result.evidence.subject?.state).toBe("uncertain");
    expect(result.evidence.invocation.observation.certainty).toBe("completed");
    expect(calls).toBe(1);
  });

  it("validates before publication and never publishes malformed evidence", async () => {
    let calls = 0;
    await expect(publishExecutionEvidence({ publish() { calls += 1; } }, { ...apply(vectors.cases[0]!), readScope: {} })).rejects.toThrow();
    expect(calls).toBe(0);
    const result = await publishExecutionEvidence({ publish() { calls += 1; } }, apply(vectors.cases[0]!));
    expect(result.status).toBe("published");
    expect(calls).toBe(1);
  });
});
