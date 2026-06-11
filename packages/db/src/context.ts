import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EmptyRelations } from "drizzle-orm/relations";
import { Context, Layer, ManagedRuntime, Redacted } from "effect";
import type { PoolConfig } from "pg";

export type BackendDb = PgDrizzle.EffectPgDatabase<EmptyRelations>;
export type BackendTx = PgDrizzle.EffectPgTransaction<PgDrizzle.EffectPgQueryResultHKT, EmptyRelations>;
export type DbSession = BackendDb | BackendTx;

export class Db extends Context.Service<Db, BackendDb>()("Db") {}

export type BackendRuntime = ManagedRuntime.ManagedRuntime<Db, never>;

export async function createBackendRuntime(config: PoolConfig): Promise<BackendRuntime> {
  if (!config.connectionString) throw new Error("connectionString is required for Effect Postgres");

  const dbLayer = Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(config.connectionString) })),
    Layer.orDie,
  );
  const runtime = ManagedRuntime.make(dbLayer);
  await runtime.runPromise(Db);
  return runtime;
}
