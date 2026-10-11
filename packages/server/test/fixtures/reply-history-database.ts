import * as PgClient from "@effect/sql-pg/PgClient";
import { Database, DatabaseLive } from "@great-minds/database";
import { Effect, Layer, Redacted, type Scope } from "effect";

const databaseUrl = process.env.REPLY_HISTORY_TEST_DATABASE_URL;
if (databaseUrl === undefined || new URL(databaseUrl).hostname !== "127.0.0.1") {
  throw new Error("Run pnpm test:history-settlement to use a dedicated disposable database");
}
const TestDatabase = DatabaseLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl) })),
);

export const runHistoryDatabase = <Value, Error>(
  use: Effect.Effect<Value, Error, Scope.Scope | Database | PgClient.PgClient>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        const [marker] = yield* client<{ database_name: string; purpose: string | null }>`
          select current_database() as database_name,
            current_setting('great_minds.test_purpose', true) as purpose
        `.pipe(Effect.orDie);
        if (
          marker?.database_name !== "gm_reply_history_test" ||
          marker.purpose !== "reply-history"
        ) {
          return yield* Effect.die(
            new Error("Reply-history tests require their marked disposable database"),
          );
        }
        return yield* use;
      }),
    ).pipe(Effect.provide(TestDatabase)),
  );
