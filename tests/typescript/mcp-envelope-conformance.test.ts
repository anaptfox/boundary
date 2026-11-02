import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateHandoffOutcome, type HandoffOutcome } from "@foxworth/boundary/handoff";
import { describeOutcome, outcomeText } from "@foxworth/boundary/remote";
import { webMcpResult } from "../../packages/callers/webmcp/execute";

type EnvelopeCase = Readonly<{
  name: string;
  outcome: unknown;
  kind: string;
  isError: boolean;
  repeat: string;
  summary: string;
}>;

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../conformance/v1/mcp-envelope.json", import.meta.url)), "utf8")) as {
  version: 1;
  textFormat: string;
  cases: readonly EnvelopeCase[];
};

describe("shared tool result envelope v1 vector", () => {
  it("names every kind a model must tell apart", () => {
    expect(vector.version).toBe(1);
    expect(new Set(vector.cases.map((entry) => entry.kind))).toEqual(
      new Set(["success", "proposed", "declared-error", "denied", "invalid", "failed", "uncertain"]),
    );
  });

  for (const entry of vector.cases) {
    it(`describes ${entry.name} exactly as reviewed`, () => {
      const outcome: HandoffOutcome = validateHandoffOutcome(entry.outcome);
      const described = describeOutcome(outcome);
      expect(described).toEqual({ kind: entry.kind, summary: entry.summary, repeat: entry.repeat, isError: entry.isError });
      expect(outcomeText(outcome)).toBe(`${entry.summary}\n${JSON.stringify(outcome, null, 2)}`);
      const result = webMcpResult(outcome);
      expect(result.structuredContent).toEqual(outcome);
      expect(result.content[0]?.text.startsWith(`${entry.summary}\n`)).toBe(true);
      expect(result.isError ?? false).toBe(entry.isError);
    });
  }

  it("never folds uncertainty into failure or retry", () => {
    for (const entry of vector.cases) {
      const certainty = (entry.outcome as { certainty: string }).certainty;
      if (certainty === "unknown" || certainty === "not-completed") {
        expect(entry.kind).toBe("uncertain");
        expect(entry.repeat).toBe("never");
        expect(entry.summary).toMatch(/Do not repeat it/u);
      }
    }
  });
});
