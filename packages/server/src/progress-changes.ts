import { PgClient } from "@effect/sql-pg/PgClient";
import type { Uuid } from "@great-minds/domain";
import { Context, Duration, Effect, Layer, Queue, Schedule, type Scope } from "effect";

import { StructuredLogger } from "./logging.ts";

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

const reconnect = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const makeProgressChanges = Effect.gen(function* () {
  const pg = yield* PgClient;
  const logger = yield* StructuredLogger;
  const subscribers = new Map<string, Set<Queue.Enqueue<void>>>();
  const wake = (queues: Iterable<Queue.Enqueue<void>>) => {
    for (const queue of queues) Queue.offerUnsafe(queue, undefined);
  };

  const listen = Effect.scoped(
    Effect.gen(function* () {
      const notifications = yield* pg.listen("great_minds_progress");
      for (const queues of subscribers.values()) wake(queues);
      while (true) {
        const { payload } = yield* Queue.take(notifications);
        const queues = subscribers.get(payload);
        if (queues !== undefined) wake(queues);
      }
    }),
  );
  yield* listen.pipe(
    Effect.tapError((error) =>
      logger.warn("progress_listener_disconnected", { error_type: error.reason._tag }),
    ),
    Effect.retry(reconnect),
    Effect.forkScoped,
  );

  return {
    subscribe: (table, { userId, vaultId }, id) => {
      const keys = [
        `${table}:${id}`,
        `vaults:${vaultId}`,
        `vault_memberships:${vaultId}:${userId}`,
      ];
      return Effect.acquireRelease(
        Effect.map(Queue.dropping<void>(1), (queue) => {
          for (const key of keys) {
            const queues = subscribers.get(key);
            if (queues === undefined) subscribers.set(key, new Set([queue]));
            else queues.add(queue);
          }
          return queue;
        }),
        (queue) =>
          Effect.sync(() => {
            for (const key of keys) {
              const queues = subscribers.get(key);
              queues?.delete(queue);
              if (queues?.size === 0) subscribers.delete(key);
            }
          }),
      );
    },
  } satisfies ProgressChangesShape;
});

export const ProgressChangesLive = Layer.effect(ProgressChanges, makeProgressChanges);
