import * as PgClient from "@effect/sql-pg/PgClient";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { eq, sql } from "drizzle-orm";
import { Config, Effect, Layer, Redacted, Schema } from "effect";

import { searchIndex, users, vaults } from "./schema.ts";

const SearchIndexRow = createSelectSchema(searchIndex);

const safeLocalDatabaseUrl = (databaseUrl: Redacted.Redacted<string>) => {
  const value = Redacted.value(databaseUrl);
  if (!value) {
    throw new Error("DATABASE_URL is required for the pgvector ANN check");
  }
  const parsed = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`Refusing to run ANN check against non-local host ${parsed.hostname}`);
  }
  if (!parsed.pathname.endsWith("gm_spike")) {
    throw new Error(`Refusing to run ANN check against database ${parsed.pathname}`);
  }
  return databaseUrl;
};

const PgClientLive = Layer.unwrap(
  Effect.map(Config.redacted("DATABASE_URL"), (url) =>
    PgClient.layer({ url: safeLocalDatabaseUrl(url) })
  )
);

const vector1024 = (head: readonly number[]) => [
  ...head,
  ...Array.from({ length: 1024 - head.length }, () => 0)
];

const vectorLiteral = (embedding: readonly number[]) => `[${embedding.join(",")}]`;

const program = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults();
  const ownerId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const query = vector1024([1, 0, 0]);
  const rows = [
    { path: "synthetic/near.md", embedding: vector1024([0.99, 0.01, 0]) },
    { path: "synthetic/mid.md", embedding: vector1024([0.7, 0.7, 0]) },
    { path: "synthetic/far.md", embedding: vector1024([0, 1, 0]) }
  ];

  yield* db.insert(users).values({
    id: ownerId,
    email: `spike-${ownerId}@example.test`
  });
  yield* db.insert(vaults).values({
    id: vaultId,
    name: "Spike Zero ANN",
    ownerId
  });
  yield* db.insert(searchIndex).values(
    rows.map((row, chunkIndex) => ({
      vaultId,
      path: row.path,
      chunkIndex,
      heading: row.path,
      body: row.path,
      contentHash: `${row.path}:hash`,
      tsv: sql`to_tsvector('english', ${row.path})`,
      embedding: row.embedding
    }))
  );

  const distance = sql<number>`${searchIndex.embedding} <=> ${vectorLiteral(query)}::vector`;
  const ordered = yield* db
    .select({
      path: searchIndex.path,
      distance
    })
    .from(searchIndex)
    .where(eq(searchIndex.vaultId, vaultId))
    .orderBy(distance);

  const decoded = Schema.decodeUnknownSync(SearchIndexRow)({
    ...(yield* db.select().from(searchIndex).where(eq(searchIndex.path, "synthetic/near.md")).limit(1))[0]
  });

  const actual = ordered.map((row) => row.path);
  const expected = ["synthetic/near.md", "synthetic/mid.md", "synthetic/far.md"];
  if (actual.join("|") !== expected.join("|")) {
    throw new Error(`Unexpected ANN order: ${actual.join(", ")}`);
  }

  console.log("[ann] order", actual.join(" > "));
  console.log("[ann] decoded search_index row", decoded.path, decoded.embedding?.length ?? 0);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(PgClientLive),
    Effect.scoped
  )
);
