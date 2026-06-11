import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EmptyRelations } from "drizzle-orm/relations";
import { ManagedRuntime, Redacted } from "effect";
import type { PoolConfig } from "pg";

export type BackendDb = PgDrizzle.EffectPgDatabase<EmptyRelations>;
export type BackendTx = PgDrizzle.EffectPgTransaction<PgDrizzle.EffectPgQueryResultHKT, EmptyRelations>;
export type DbSession = BackendDb | BackendTx;

export type BackendContext = {
  db: BackendDb;
  runtime: { dispose: () => Promise<void> };
};

export async function createBackendContext(config: PoolConfig): Promise<BackendContext> {
  if (!config.connectionString) throw new Error("connectionString is required for Effect Postgres");

  const runtime = ManagedRuntime.make(
    PgClient.layer({ url: Redacted.make(config.connectionString) }),
  );
  const db = await runtime.runPromise(PgDrizzle.makeWithDefaults());
  return { db, runtime };
}

export async function closeBackendContext(context: BackendContext): Promise<void> {
  await context.runtime.dispose();
}
