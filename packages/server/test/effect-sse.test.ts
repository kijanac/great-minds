import * as Sse from "effect/unstable/encoding/Sse";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { pollingSse } from "../src/polling-sse.ts";

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

describe("snapshot polling", () => {
  it("deduplicates snapshots and emits the terminal snapshot before done", async () => {
    const rows = [undefined, 1, 1, 2];
    const events = pollingSse("reply", Effect.sync(() => rows.shift()), (version) => ({
      version, data: String(version), terminal: version === 2,
    }), 1);
    expect(await Effect.runPromise(Stream.runCollect(events))).toEqual([
      { event: "connected", data: '{"id":"reply"}' },
      { event: "message", data: "1" },
      { event: "message", data: "2" },
      { event: "done", data: '{"id":"reply"}' },
    ]);
  });

  it("sends heartbeats while unchanged and closes without a trailing heartbeat", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const read = Effect.sync(() => {
        now += 15_000;
        return now >= 60_000 ? 2 : 1;
      });
      const events = pollingSse("reply", read, (version) => ({
        version, data: String(version), terminal: version === 2,
      }), 1);
      expect(await Effect.runPromise(Stream.runCollect(events))).toEqual([
        { event: "connected", data: '{"id":"reply"}' },
        { event: "message", data: "1" },
        { event: "message", data: "" },
        { event: "message", data: "2" },
        { event: "done", data: '{"id":"reply"}' },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("interrupts an in-flight read when the stream consumer disconnects", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let stopped = false;
    const read = Effect.gen(function* () {
      started();
      return yield* Effect.never;
    }).pipe(Effect.ensuring(Effect.sync(() => { stopped = true; })));
    const events = pollingSse("reply", read, () => ({ version: 1, data: "", terminal: false }), 100);
    const completed = Effect.runPromiseExit(Stream.runCollect(events), { signal: controller.signal });
    await reading;
    controller.abort();
    expect(Exit.isFailure(await completed)).toBe(true);
    expect(stopped).toBe(true);
  });
});
