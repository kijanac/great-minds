import { drizzle, type NodePgDatabase, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { EmptyRelations } from "drizzle-orm/relations";
import pg, { type PoolConfig } from "pg";

const { Pool } = pg;

export type BackendDb = NodePgDatabase<EmptyRelations>;
export type BackendTx = NodePgTransaction<EmptyRelations>;
export type DbSession = BackendDb | BackendTx;

export type BackendContext = {
  db: BackendDb;
  pool: pg.Pool;
};

export function createBackendContext(config: PoolConfig): BackendContext {
  const pool = new Pool(config);
  return { pool, db: drizzle({ client: pool }) };
}

export async function closeBackendContext(context: BackendContext): Promise<void> {
  await context.pool.end();
}
