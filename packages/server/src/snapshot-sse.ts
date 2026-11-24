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
      let previousVersion: Snapshot["version"] | undefined;
      let nextReadAt = yield* monotonicMillis;
      let heartbeatAt = nextReadAt;

      const readFrame = Effect.gen(function* () {
        const untilHeartbeat = heartbeatAt - (yield* monotonicMillis);
        if (untilHeartbeat > 0)
          yield* Effect.raceFirst(Queue.peek(wakes), Effect.sleep(untilHeartbeat));
        const untilReadable = nextReadAt - (yield* monotonicMillis);
        if (untilReadable > 0) yield* Effect.sleep(untilReadable);
        yield* Queue.poll(wakes);
        nextReadAt = (yield* monotonicMillis) + minReadIntervalMs;
        const row = yield* read;
        if (row === undefined) return yield* Cause.done();
        const current = snapshot(row);
        const changed = current.version !== previousVersion;
        const now = yield* monotonicMillis;
        if (!changed && now < heartbeatAt) return [];
        heartbeatAt = now + heartbeatIntervalMs;
        if (!changed) return [{ event: "heartbeat", data: "{}" }];
        previousVersion = current.version;
        const message = { event: "message", data: current.data() };
        return current.terminal ? [message, { event: "done", data: identity }] : [message];
      });

      return Stream.concat(
        Stream.succeed({ event: "connected", data: identity }),
        Stream.fromIterableEffectRepeat(readFrame),
      ).pipe(Stream.takeUntil((event) => event.event === "done"));
    }),
  );
