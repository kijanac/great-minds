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

export type BackendContext = {
  runtime: BackendRuntime;
};

function createBackendRuntime(config: PoolConfig): BackendRuntime {
  if (!config.connectionString) throw new Error("connectionString is required for Effect Postgres");

  const dbLayer = Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(config.connectionString) })),
    Layer.orDie,
  );
  return ManagedRuntime.make(dbLayer);
}

export async function createBackendContext(config: PoolConfig): Promise<BackendContext> {
  const runtime = createBackendRuntime(config);
  await runtime.runPromise(Db);
  return { runtime };
}

export async function closeBackendContext(context: BackendContext): Promise<void> {
  await context.runtime.dispose();
}
