import * as Sse from "effect/unstable/encoding/Sse";
import { describe, expect, it } from "vitest";

describe("Effect SSE decoder", () => {
  it("preserves a named multiline event when CRLF is split across chunks", () => {
    const events: Sse.AnyEvent[] = [];
    const parser = Sse.makeParser((event) => events.push(event));
    const frame = "event: update\r\ndata: first\r\ndata: second\r\n\r\n";

    for (const character of frame) {
      expect(parser.feed(character)).toBeUndefined();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _tag: "Event",
      event: "update",
      data: "first\nsecond",
    });
  });
});
