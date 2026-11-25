import { Cause, Effect, type Queue, type Scope, Stream } from "effect";
import type { EventEncoded } from "effect/encoding/Sse";

import { monotonicMillis, progressBackstopMs, progressReader } from "./progress-changes.ts";

type Snapshot = {
  readonly version: string | number;
  readonly data: () => string;
  readonly terminal: boolean;
};

export const snapshotSse = <A>(
  id: string,
  subscribe: Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope>,
  read: Effect.Effect<A | undefined>,
  snapshot: (row: A) => Snapshot,
): Stream.Stream<EventEncoded> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const readNext = yield* progressReader(subscribe, read);
      const identity = JSON.stringify({ id });
      let previousVersion: Snapshot["version"] | undefined;
      let heartbeatAt = yield* monotonicMillis;

      const readFrame = Effect.gen(function* () {
        const row = yield* readNext(heartbeatAt - (yield* monotonicMillis));
        if (row === undefined) return yield* Cause.done();
        const current = snapshot(row);
        const changed = current.version !== previousVersion;
        const now = yield* monotonicMillis;
        if (!changed && now < heartbeatAt) return [];
        heartbeatAt = now + progressBackstopMs;
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
