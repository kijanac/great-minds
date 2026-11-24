import * as Sse from "effect/encoding/Sse";
import { Effect, Exit, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { snapshotSse } from "../src/snapshot-sse.ts";

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

describe("snapshot SSE", () => {
  it("reads on wakes and at the idle heartbeat, with a terminal snapshot before done", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const wakes = yield* Queue.dropping<void>(1);
        let version = 1;
        let reads = 0;
        const read = Effect.sync(() => {
          reads++;
          return version;
        });
        const stream = snapshotSse("reply", Effect.succeed(wakes), read, (value) => ({
          version: value,
          data: () => String(value),
          terminal: value === 3,
        }));
        const consuming = yield* Effect.forkChild(Stream.runCollect(stream));
        yield* TestClock.adjust("10 seconds");
        expect(reads).toBe(1);
        version = 2;
        yield* Queue.offer(wakes, undefined);
        yield* TestClock.adjust("29999 millis");
        expect(reads).toBe(2);
        yield* TestClock.adjust("1 millis");
        expect(reads).toBe(3);
        version = 3;
        yield* Queue.offer(wakes, undefined);
        yield* TestClock.adjust("100 millis");
        return yield* Fiber.join(consuming);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(events).toEqual([
      { event: "connected", data: '{"id":"reply"}' },
      { event: "message", data: "1" },
      { event: "message", data: "2" },
      { event: "heartbeat", data: "{}" },
      { event: "message", data: "3" },
      { event: "done", data: '{"id":"reply"}' },
    ]);
  });

  it("interrupts an in-flight read when the stream consumer disconnects", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stopped = false;
    const read = Effect.gen(function* () {
      started();
      return yield* Effect.never;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stopped = true;
        }),
      ),
    );
    const events = snapshotSse("reply", Queue.dropping<void>(1), read, () => ({
      version: 1,
      data: () => "",
      terminal: false,
    }));
    const completed = Effect.runPromiseExit(Stream.runCollect(events), {
      signal: controller.signal,
    });
    await reading;
    controller.abort();
    expect(Exit.isFailure(await completed)).toBe(true);
    expect(stopped).toBe(true);
  });
});
