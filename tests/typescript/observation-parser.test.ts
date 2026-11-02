import { describe, expect, it } from "vitest";
import { createObservationParser } from "../../packages/callers/client/observation-parser";

function parse(chunks: readonly string[]) {
  const parser = createObservationParser();
  return chunks.flatMap((chunk) => [...parser.feed(chunk)]);
}

describe("observation SSE framing", () => {
  it.each(["\n", "\r", "\r\n"])("preserves every split of %j line endings", (ending) => {
    const input = `event: observation${ending}data: first${ending}data: second${ending}${ending}`;
    const expected = [{ event: "observation", data: "first\nsecond" }];
    for (let split = 0; split <= input.length; split += 1) {
      expect(parse([input.slice(0, split), "", input.slice(split)]), `split ${split}`).toEqual(expected);
    }
    expect(parse([...input])).toEqual(expected);
  });

  it("combines mixed line endings without treating a fragmented CRLF as a blank line", () => {
    expect(parse(["data: first\r", "", "\ndata: second\r", "data: third\n\r", "\n"])).toEqual([
      { event: "message", data: "first\nsecond\nthird" },
    ]);
  });

  it("uses literal fields, the first colon, and exactly one optional ASCII space", () => {
    expect(parse([
      ": comment\nevent:  observation\ndata:  spaced: value\n data: ignored\nData: ignored\n\n",
      "event:\tobservation\ndata:\tvalue\n\n",
      "event: observation\nevent\ndata: final\n\n",
    ])).toEqual([
      { event: " observation", data: " spaced: value" },
      { event: "\tobservation", data: "\tvalue" },
      { event: "message", data: "final" },
    ]);
  });

  it("preserves empty data lines and dispatches only events containing a data field", () => {
    expect(parse(["event: ready\n\ndata:\n\ndata\ndata: value\ndata\n\nevent: unused\n\ndata: next\n\n"])).toEqual([
      { event: "message", data: "" },
      { event: "message", data: "\nvalue\n" },
      { event: "message", data: "next" },
    ]);
  });

  it.each(["data: unfinished", "data: unfinished\n", "event: observation\ndata: unfinished\r"])(
    "does not dispatch an unterminated event at EOF: %j", (input) => {
      expect(parse([input])).toEqual([]);
    },
  );

  it("checks a complete oversized frame before dispatch, with the existing raw-line limit", () => {
    const exact = `data: ${"x".repeat(65_536 - 6)}\n\n`;
    expect(parse([exact])[0]?.data).toHaveLength(65_536 - 6);
    const oversized = `data: ${"x".repeat(65_536 - 5)}\n\n`;
    expect(() => parse([oversized])).toThrow("size limit");
    expect(() => parse([oversized.slice(0, 100), oversized.slice(100)])).toThrow("size limit");
  });

  it("bounds partial lines, accumulated data, and ignored fields before a blank line", () => {
    expect(() => parse(["x".repeat(65_536), "x"])).toThrow("size limit");
    expect(() => parse(["data:\n".repeat(13_108)])).toThrow("size limit");
    expect(() => parse([": ".repeat(32_769) + "\n\n"])).toThrow("size limit");
    const parser = createObservationParser();
    expect(() => [...parser.feed("x".repeat(65_537))]).toThrow("size limit");
    expect(() => [...parser.feed("data: safe\n\n")]).toThrow("size limit");
  });

  it("releases the size allowance after each event, including many events in one chunk", () => {
    const input = "data: ok\n\n".repeat(10_000);
    const events = parse([input]);
    expect(events).toHaveLength(10_000);
    expect(events.at(-1)).toEqual({ event: "message", data: "ok" });
  });
});
