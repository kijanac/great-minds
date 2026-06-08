import type { EmptyRelations } from "drizzle-orm/relations";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PgliteTransaction } from "drizzle-orm/pglite/session";

export type LocalDb = PgliteDatabase<EmptyRelations>;

export type Transaction = PgliteTransaction<EmptyRelations>;
