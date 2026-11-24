import { Cause, Effect, Stream } from "effect";
import type { EventEncoded } from "effect/encoding/Sse";

type Snapshot = {
  readonly version: string | number;
  readonly data: () => string;
  readonly terminal: boolean;
};

const heartbeatIntervalMs = 30_000;

export const pollingSse = <A>(
  id: string,
  read: Effect.Effect<A | undefined>,
  snapshot: (row: A) => Snapshot,
  pollIntervalMs: number,
): Stream.Stream<EventEncoded> =>
  Stream.suspend(() => {
    const identity = JSON.stringify({ id });
    let previousVersion: string | number | undefined;
    let lastSentAt = Date.now();
    let first = true;

    const poll = Effect.gen(function* () {
      if (!first) yield* Effect.sleep(pollIntervalMs);
      first = false;
      const row = yield* read;
      if (row === undefined) return yield* Cause.done();
      const current = snapshot(row);
      const now = Date.now();
      if (current.version === previousVersion) {
        if (now - lastSentAt < heartbeatIntervalMs) return [];
        lastSentAt = now;
        return [{ event: "heartbeat", data: "{}" }];
      }
      previousVersion = current.version;
      lastSentAt = now;
      const message = { event: "message", data: current.data() };
      return current.terminal ? [message, { event: "done", data: identity }] : [message];
    });

    return Stream.concat(
      Stream.fromIterable<EventEncoded>([{ event: "connected", data: identity }]),
      Stream.fromIterableEffectRepeat(poll),
    ).pipe(Stream.takeUntil((event) => event.event === "done"));
  });
