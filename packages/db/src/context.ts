import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EmptyRelations } from "drizzle-orm/relations";
import { Context, Layer, ManagedRuntime, Redacted } from "effect";

export type BackendDbConfig = { readonly connectionString: string };
export type BackendDb = PgDrizzle.EffectPgDatabase<EmptyRelations>;
export type BackendTx = PgDrizzle.EffectPgTransaction<PgDrizzle.EffectPgQueryResultHKT, EmptyRelations>;
export type DbSession = BackendDb | BackendTx;

export class Db extends Context.Service<Db, BackendDb>()("Db") {}

export type BackendRuntime = ManagedRuntime.ManagedRuntime<Db, never>;

export function createDbLayer(config: BackendDbConfig): Layer.Layer<Db, never> {
  if (!config.connectionString) throw new Error("connectionString is required for Effect Postgres");

  return Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(config.connectionString) })),
    Layer.orDie,
  );
}

export async function createBackendRuntime(config: BackendDbConfig): Promise<BackendRuntime> {
  const runtime = ManagedRuntime.make(createDbLayer(config));
  await runtime.runPromise(Db);
  return runtime;
}
