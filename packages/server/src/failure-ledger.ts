import { compileCacheEntries, type Database } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";

export const SET_ASIDE_AFTER = 3;

export const SET_ASIDE_MESSAGE = `set aside after ${SET_ASIDE_AFTER} failed attempts; retried when their input changes`;

const FailureRecord = Schema.Struct({
  attempts: Schema.Number,
  reason: Schema.String,
  message: Schema.String,
});

export type Failures = { readonly failed: string[]; readonly setAside: string[] };

export const noFailures = (): Failures => ({ failed: [], setAside: [] });

export const sortedFailures = (failures: Failures): Failures => ({
  failed: failures.failed.toSorted(),
  setAside: failures.setAside.toSorted(),
});

export const failedAttempts = (
  db: Database["Service"],
  vaultId: Uuid,
  phase: string,
  key: string,
) =>
  db
    .query((d) =>
      d
        .select({ value: compileCacheEntries.value })
        .from(compileCacheEntries)
        .where(
          and(
            eq(compileCacheEntries.vaultId, vaultId),
            eq(compileCacheEntries.phase, `failed:${phase}`),
            eq(compileCacheEntries.cacheKey, key),
          ),
        )
        .limit(1),
    )
    .pipe(
      Effect.map(([row]) =>
        row === undefined
          ? 0
          : Option.match(Schema.decodeUnknownOption(FailureRecord)(row.value), {
              onNone: () => 0,
              onSome: (record) => record.attempts,
            }),
      ),
    );

export const recordFailure = (
  db: Database["Service"],
  vaultId: Uuid,
  phase: string,
  key: string,
  failure: { readonly reason: string; readonly message: string },
) =>
  db
    .query((d) =>
      d
        .insert(compileCacheEntries)
        .values({
          vaultId,
          phase: `failed:${phase}`,
          cacheKey: key,
          value: { attempts: 1, reason: failure.reason, message: failure.message },
        })
        .onConflictDoUpdate({
          target: [
            compileCacheEntries.vaultId,
            compileCacheEntries.phase,
            compileCacheEntries.cacheKey,
          ],
          set: {
            value: sql`jsonb_build_object(
              'attempts', coalesce((${compileCacheEntries.value} ->> 'attempts')::int, 0) + 1,
              'reason', ${failure.reason}::text,
              'message', ${failure.message}::text
            )`,
          },
        }),
    )
    .pipe(Effect.asVoid);
