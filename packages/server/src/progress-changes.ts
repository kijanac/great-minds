import { PgClient } from "@effect/sql-pg/PgClient";
import type { Uuid } from "@great-minds/domain";
import { Clock, Context, Effect, Layer, Queue, Schedule, type Scope } from "effect";

import { StructuredLogger } from "./logging.ts";

export const progressBackstopMs = 30_000;
const minReadIntervalMs = 100;
export const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) =>
  Number(nanos / 1_000_000n),
);

export const progressReader = <A>(
  subscribe: Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope>,
  read: Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const wakes = yield* subscribe;
    let nextReadAt = yield* monotonicMillis;
    return (waitMs = progressBackstopMs) =>
      Effect.gen(function* () {
        if (waitMs > 0) yield* Effect.raceFirst(Queue.peek(wakes), Effect.sleep(waitMs));
        const untilReadable = nextReadAt - (yield* monotonicMillis);
        if (untilReadable > 0) yield* Effect.sleep(untilReadable);
        yield* Queue.poll(wakes);
        nextReadAt = (yield* monotonicMillis) + minReadIntervalMs;
        return yield* read;
      });
  });

type ProgressChangesShape = {
  readonly subscribe: (
    table: "pipeline_runs" | "replies",
    member: { readonly userId: Uuid; readonly vaultId: Uuid },
    id: Uuid,
  ) => Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope>;
};

export class ProgressChanges extends Context.Service<ProgressChanges, ProgressChangesShape>()(
  "@great-minds/server/ProgressChanges",
) {}

const reconnect = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

const makeProgressChanges = Effect.gen(function* () {
  const pg = yield* PgClient;
  const logger = yield* StructuredLogger;
  const subscribers = new Map<Queue.Enqueue<void>, readonly string[]>();
  const wake = (key?: string) => {
    for (const [queue, keys] of subscribers) {
      if (key === undefined || keys.includes(key)) Queue.offerUnsafe(queue, undefined);
    }
  };

  const listen = Effect.gen(function* () {
    const notifications = yield* pg.listen("great_minds_progress");
    wake();
    while (true) wake((yield* Queue.take(notifications)).payload);
  }).pipe(Effect.scoped);
  yield* listen.pipe(
    Effect.tapError((error) =>
      logger.warn("progress_listener_disconnected", { error_type: error.reason._tag }),
    ),
    Effect.retry(reconnect),
    Effect.forkScoped,
  );

  return {
    subscribe: (table, { userId, vaultId }, id) =>
      Effect.acquireRelease(
        Effect.map(Queue.dropping<void>(1), (queue) => {
          subscribers.set(queue, [
            `${table}:${id}`,
            `vaults:${vaultId}`,
            `vault_memberships:${vaultId}:${userId}`,
          ]);
          return queue;
        }),
        (queue) => Effect.sync(() => subscribers.delete(queue)),
      ),
  } satisfies ProgressChangesShape;
});

export const ProgressChangesLive = Layer.effect(ProgressChanges, makeProgressChanges);
