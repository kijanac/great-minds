import { PgClient } from "@effect/sql-pg/PgClient";
import type { Uuid } from "@great-minds/domain";
import { Context, Effect, Layer, Queue, Schedule, type Scope } from "effect";

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
