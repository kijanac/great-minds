import { Cause, Clock, Effect, Queue, type Scope, Stream } from "effect";
import type { EventEncoded } from "effect/encoding/Sse";

type Snapshot = {
  readonly version: string | number;
  readonly data: () => string;
  readonly terminal: boolean;
};

const heartbeatIntervalMs = 30_000;
const minReadIntervalMs = 100;
const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n));

export const snapshotSse = <A>(
  id: string,
  subscribe: Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope>,
  read: Effect.Effect<A | undefined>,
  snapshot: (row: A) => Snapshot,
): Stream.Stream<EventEncoded> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const wakes = yield* subscribe;
      const identity = JSON.stringify({ id });
      let previousVersion: string | number | undefined;
      let lastSentAt = yield* monotonicMillis;
      let lastReadAt: number | undefined;

      const readFrame = Effect.gen(function* () {
        if (lastReadAt !== undefined) {
          const now = yield* monotonicMillis;
          const untilHeartbeat = lastSentAt + heartbeatIntervalMs - now;
          if (untilHeartbeat > 0)
            yield* Effect.raceFirst(Queue.take(wakes), Effect.sleep(untilHeartbeat));
          const readyAt = yield* monotonicMillis;
          const delay = lastReadAt + minReadIntervalMs - readyAt;
          if (delay > 0) yield* Effect.sleep(delay);
          yield* Queue.poll(wakes);
        }
        lastReadAt = yield* monotonicMillis;
        const row = yield* read;
        if (row === undefined) return yield* Cause.done();
        const current = snapshot(row);
        const sentAt = yield* monotonicMillis;
        if (current.version === previousVersion) {
          if (sentAt - lastSentAt < heartbeatIntervalMs) return [];
          lastSentAt = sentAt;
          return [{ event: "heartbeat", data: "{}" }];
        }
        previousVersion = current.version;
        lastSentAt = sentAt;
        const message = { event: "message", data: current.data() };
        return current.terminal ? [message, { event: "done", data: identity }] : [message];
      });

      return Stream.concat(
        Stream.fromIterable<EventEncoded>([{ event: "connected", data: identity }]),
        Stream.fromIterableEffectRepeat(readFrame),
      ).pipe(Stream.takeUntil((event) => event.event === "done"));
    }),
  );
