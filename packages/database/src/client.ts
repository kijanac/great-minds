import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer } from "effect";

type DatabaseClient = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

export class Database extends Context.Service<Database, DatabaseClient>()(
  "@great-minds/database/Database"
) {}

export const DatabaseLive = Layer.effect(Database, PgDrizzle.makeWithDefaults());
