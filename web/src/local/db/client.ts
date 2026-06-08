import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import type { LocalDb } from "./types";

type AppliedMigrationRow = {
  name: string;
};

const migrationModules = import.meta.glob<string>("./migrations/*/migration.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

async function migrate(client: PGlite): Promise<void> {
  await client.exec(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await client.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await client.exec(`
    CREATE TABLE IF NOT EXISTS __great_minds_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = await client.query<AppliedMigrationRow>(
    `SELECT name FROM __great_minds_migrations`,
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));

  const migrations = Object.entries(migrationModules).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [path, sql] of migrations) {
    const name = path.split("/").at(-2);
    if (!name || appliedNames.has(name)) continue;

    await client.exec("BEGIN");
    try {
      await client.exec(sql);
      await client.query(`INSERT INTO __great_minds_migrations (name) VALUES ($1)`, [name]);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function createLocalContext(options: { dataDir: string }) {
  const client = await PGlite.create({
    dataDir: options.dataDir,
    extensions: {
      pgcrypto,
      vector,
    },
  });

  await migrate(client);

  const db: LocalDb = drizzle({ client });

  return { client, db };
}

export type LocalContext = Awaited<ReturnType<typeof createLocalContext>>;
