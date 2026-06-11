import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createBackendContext, closeBackendContext, Db } from "./context.js";

export async function runMigrations(connectionString: string): Promise<void> {
  const context = await createBackendContext({ connectionString });

  try {
    await context.runtime.runPromise(
      Effect.flatMap(Db, (db) => migrate(db, { migrationsFolder: migrationsFolder() })),
    );
  } finally {
    await closeBackendContext(context);
  }
}

function migrationsFolder(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required to run migrations");

  await runMigrations(DATABASE_URL);
}
