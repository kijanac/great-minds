import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";

import { DatabaseLive } from "./client.ts";
import { logMigrationResult, migrateDatabase } from "./migrate.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required");
}

const MigrationLive = DatabaseLive.pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
);
const result = await Effect.runPromise(migrateDatabase.pipe(Effect.provide(MigrationLive)));
logMigrationResult(result);
