import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Effect } from "effect";

import { Database } from "./client.ts";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const migrationConfig = { migrationsFolder } as const;
const expectedAlembicRevision = "0007";
const advisoryLockId = "7414217876221336179";

type QueryRows<T> = { readonly rows: readonly T[] };

const rows = <T>(result: unknown) => (result as QueryRows<T>).rows;

export const alembicHeadMismatchMessage = (actual: string | null) =>
  `Database schema revision mismatch: expected alembic head ${expectedAlembicRevision}, found ${actual ?? "<missing>"}`;

export type MigrationResult = {
  readonly adoption: null | {
    readonly alembicRevision: string;
    readonly baseline: string;
  };
  readonly applied: readonly string[];
};

export const migrateDatabase = Effect.gen(function* () {
  const db = yield* Database;
  const localMigrations = yield* Effect.sync(() => readMigrationFiles(migrationConfig));
  const baseline = localMigrations.find((migration) => migration.name.endsWith("_baseline"));
  if (baseline === undefined) {
    return yield* Effect.die(new Error("Drizzle baseline migration is missing"));
  }

  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(sql`select pg_advisory_xact_lock(${advisoryLockId}::bigint)`);

      const journalLookup = yield* tx.execute(
        sql<{ journal: string | null }>`
          select to_regclass('drizzle.__drizzle_migrations')::text as journal
        `,
      );
      let journalExists = rows<{ journal: string | null }>(journalLookup)[0]?.journal !== null;
      let adoption: MigrationResult["adoption"] = null;

      if (!journalExists) {
        const alembicLookup = yield* tx.execute(
          sql<{ table_name: string | null }>`
            select to_regclass('public.alembic_version')::text as table_name
          `,
        );
        const alembicExists =
          rows<{ table_name: string | null }>(alembicLookup)[0]?.table_name !== null;

        if (alembicExists) {
          const revisionResult = yield* tx.execute(
            sql<{ version_num: string }>`select version_num from alembic_version`,
          );
          const actual = rows<{ version_num: string }>(revisionResult)[0]?.version_num ?? null;
          if (actual !== expectedAlembicRevision) {
            return yield* Effect.die(new Error(alembicHeadMismatchMessage(actual)));
          }

          yield* tx.execute(sql`create schema if not exists drizzle`);
          yield* tx.execute(sql`
            create table drizzle.__drizzle_migrations (
              id serial primary key,
              hash text not null,
              created_at bigint,
              name text,
              applied_at timestamp with time zone default now()
            )
          `);
          yield* tx.execute(sql`
            insert into drizzle.__drizzle_migrations (hash, created_at, name)
            values (${baseline.hash}, ${baseline.folderMillis}, ${baseline.name})
          `);
          journalExists = true;
          adoption = {
            alembicRevision: expectedAlembicRevision,
            baseline: baseline.name,
          };
        }
      }

      const appliedBefore = journalExists
        ? rows<{ name: string | null }>(
            yield* tx.execute(
              sql<{ name: string | null }>`
                select name from drizzle.__drizzle_migrations order by id
              `,
            ),
          )
            .map((entry) => entry.name)
            .filter((name): name is string => name !== null)
        : [];

      yield* migrate(tx, migrationConfig);

      const appliedBeforeSet = new Set(appliedBefore);
      const applied = rows<{ name: string | null }>(
        yield* tx.execute(
          sql<{ name: string | null }>`
            select name from drizzle.__drizzle_migrations order by id
          `,
        ),
      )
        .map((entry) => entry.name)
        .filter((name): name is string => name !== null && !appliedBeforeSet.has(name));

      return { adoption, applied } satisfies MigrationResult;
    }),
  );
}).pipe(Effect.orDie);

export const logMigrationResult = (result: MigrationResult) => {
  if (result.adoption !== null) {
    console.log(
      JSON.stringify({
        event: "database_migration_adopted",
        alembic_revision: result.adoption.alembicRevision,
        migration: result.adoption.baseline,
      }),
    );
  }
  if (result.applied.length > 0) {
    console.log(
      JSON.stringify({
        event: "database_migrations_applied",
        migrations: result.applied,
      }),
    );
  } else {
    console.log(JSON.stringify({ event: "database_migrations_current" }));
  }
};
