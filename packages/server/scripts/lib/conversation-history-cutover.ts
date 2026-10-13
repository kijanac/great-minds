import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import * as PgClient from "@effect/sql-pg/PgClient";
import { migrateDatabase } from "@great-minds/database";
import { Effect, Stream } from "effect";

import {
  ConversionBlocked,
  type ConversationSnapshot,
  type ConversionPlan,
} from "./conversation-history-conversion.ts";

export const requireMigrationCopy = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [marker] = yield* sql<{ purpose: string | null; rehearsal: string | null }>`
    SELECT current_setting('great_minds.migration_purpose', true) AS purpose,
           current_setting('great_minds.test_purpose', true) AS rehearsal
  `;
  if (marker?.purpose !== "conversation-history-copy" && marker?.rehearsal !== "reply-history")
    return yield* Effect.fail(new ConversionBlocked("database_is_not_marked_as_an_isolated_copy"));
});

export const captureConversationDatabase = Effect.gen(function* () {
  yield* requireMigrationCopy;
  const sql = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      yield* sql`SET LOCAL TIME ZONE 'UTC'`;
      const sessionRows = yield* sql<{
        value: unknown;
      }>`SELECT to_jsonb(s) AS value FROM sessions s ORDER BY vault_id, id`;
      const replyRows = yield* sql<{
        value: unknown;
      }>`SELECT to_jsonb(r) AS value FROM replies r ORDER BY id`;
      const controls = yield* captureControls;
      return {
        sessions: sessionRows.map((row) => row.value),
        replies: replyRows.map((row) => row.value),
        controls,
      };
    }),
  );
});

const captureControls = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const tables = yield* sql<{ tablename: string }>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('sessions', 'replies') ORDER BY tablename COLLATE "C"
  `;
  const controls: { table: string; sha256: string }[] = [];
  for (const { tablename } of tables) {
    const hash = createHash("sha256");
    yield* Stream.runForEach(
      sql<{ digest: string }>`
      SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') COLLATE "C" AS digest FROM ${sql(tablename)} t ORDER BY digest
    `.stream,
      ({ digest }) =>
        Effect.sync(() => {
          hash.update(`${digest}\n`);
        }),
    );
    controls.push({ table: tablename, sha256: hash.digest("hex") });
  }
  return controls;
});

const nativeSchema = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [{ native }] = yield* sql<{ native: boolean }>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'history_seq') AS native
  `;
  return native;
});

const rowsMatch = (
  actual: readonly { key: string; value: unknown }[],
  expected: readonly { key: string; before: unknown; after: unknown }[],
  afterOnly: boolean,
) => {
  const byKey = new Map(expected.map((row) => [row.key, row]));
  return (
    actual.length === byKey.size &&
    actual.every((row) => {
      const match = byKey.get(row.key);
      return (
        match !== undefined &&
        (isDeepStrictEqual(row.value, match.after) ||
          (!afterOnly && isDeepStrictEqual(row.value, match.before)))
      );
    })
  );
};

export const verifyConversationDatabase = (
  snapshot: ConversationSnapshot,
  plan: ConversionPlan,
  afterOnly = false,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`SET LOCAL TIME ZONE 'UTC'`;
    const native = yield* nativeSchema;
    if (afterOnly && !native)
      return yield* Effect.fail(new ConversionBlocked("native_schema_missing"));
    const currentSessions = yield* sql<{
      key: string;
      value: unknown;
    }>`SELECT vault_id::text || '/' || id AS key, to_jsonb(s) AS value FROM sessions s`;
    const currentReplies = yield* sql<{
      key: string;
      value: unknown;
    }>`SELECT id::text AS key, to_jsonb(r) AS value FROM replies r`;
    const expectedSessions = native
      ? plan.patch.sessions.map((pair) => ({
          key: `${pair.before.vault_id}/${pair.before.id}`,
          ...pair,
        }))
      : snapshot.sessions.map((row) => ({
          key: `${row.vault_id}/${row.id}`,
          before: row,
          after: row,
        }));
    const expectedReplies = plan.patch.replies.map((pair) => {
      const { settlement: _before, ...before } = pair.before;
      const { settlement: _after, ...after } = pair.after;
      return {
        key: pair.before.id,
        before: native ? pair.before : before,
        after: native ? pair.after : after,
      };
    });
    if (
      !rowsMatch(currentSessions, expectedSessions, afterOnly) ||
      !rowsMatch(currentReplies, expectedReplies, afterOnly)
    )
      return yield* Effect.fail(new ConversionBlocked("database_changed_since_inventory"));
    if (!isDeepStrictEqual(yield* captureControls, snapshot.controls))
      return yield* Effect.fail(new ConversionBlocked("protected_database_tables_changed"));
  });

const updateReplies = (plan: ConversionPlan) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const { after } of plan.patch.replies) {
      yield* sql`
      UPDATE replies SET (status, answer, sources, error, version, request, active_generation_step, active_generation_kind, active_generation_key) =
        (SELECT status, answer, sources, error, version, request, active_generation_step, active_generation_kind, active_generation_key
         FROM jsonb_populate_record(NULL::replies, ${JSON.stringify(after)}::jsonb))
      WHERE id = ${after.id}::uuid
    `;
    }
  });

export const commitConversationDatabase = (snapshot: ConversationSnapshot, plan: ConversionPlan) =>
  Effect.gen(function* () {
    yield* requireMigrationCopy;
    if (plan.report.errors.length > 0)
      return yield* Effect.fail(new ConversionBlocked("unresolved_conversion_exceptions"));
    const sql = yield* PgClient.PgClient;
    if (!(yield* nativeSchema)) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`LOCK TABLE sessions, replies IN EXCLUSIVE MODE NOWAIT`;
          yield* verifyConversationDatabase(snapshot, plan);
          yield* updateReplies(plan);
        }),
      );
      yield* migrateDatabase;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`LOCK TABLE sessions, replies IN EXCLUSIVE MODE NOWAIT`;
        yield* verifyConversationDatabase(snapshot, plan);
        yield* updateReplies(plan);
        for (const { after } of plan.patch.sessions) {
          yield* sql`UPDATE sessions SET history_seq = ${after.history_seq}, history_sha256 = ${after.history_sha256}
          WHERE id = ${after.id} AND vault_id = ${after.vault_id}::uuid`;
        }
        yield* verifyConversationDatabase(snapshot, plan, true);
      }),
    );
  });
