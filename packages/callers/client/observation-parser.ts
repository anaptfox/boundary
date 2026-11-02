type ObservationStreamEvent = Readonly<{ event: string; data: string }>;

/** Internal SSE framing; reconnect and observation authority belong to the caller. */
export function createObservationParser() {
  const limit = 65_536;
  const fragments: string[] = [];
  const data: string[] = [];
  let pendingLength = 0;
  let size = 0;
  let event = "";
  let skipLf = false;
  let failed = false;

  const append = (fragment: string) => {
    // Preserve the observation client's raw-line accounting, including ignored
    // fields/comments. Check before retaining or dispatching a complete line.
    if (size + pendingLength + fragment.length > limit) {
      failed = true;
      fragments.length = 0;
      data.length = 0;
      event = "";
      throw new Error("observation event exceeds size limit");
    }
    fragments.push(fragment);
    pendingLength += fragment.length;
  };
  const line = (): ObservationStreamEvent | undefined => {
    const value = fragments.join("");
    fragments.length = 0;
    size += pendingLength;
    pendingLength = 0;
    if (value === "") {
      const result = data.length > 0 ? { event: event || "message", data: data.join("\n") } : undefined;
      data.length = 0;
      event = "";
      size = 0;
      return result;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    // SSE strips exactly one ASCII space, without trimming other whitespace.
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") event = content;
    else if (field === "data") data.push(content);
  };

  function* feed(chunk: string): Generator<ObservationStreamEvent> {
    if (failed) throw new Error("observation event exceeds size limit");
    let start = 0;
    if (skipLf && chunk.length > 0) {
      skipLf = false;
      if (chunk.charCodeAt(0) === 10) start = 1;
    }
    for (let cursor = start; cursor < chunk.length; cursor += 1) {
      const code = chunk.charCodeAt(cursor);
      if (code !== 10 && code !== 13) continue;
      if (cursor > start) append(chunk.slice(start, cursor));
      const result = line();
      if (code === 13) {
        if (chunk.charCodeAt(cursor + 1) === 10) cursor += 1;
        else if (cursor === chunk.length - 1) skipLf = true;
      }
      start = cursor + 1;
      if (result) yield result;
    }
    if (start < chunk.length) append(chunk.slice(start));
  }

  // EOF has no implicit blank line: pending lines/events are discarded with
  // this connection. A CR already terminates its line, even at a chunk edge.
  return { feed };
}
