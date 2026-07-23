import { Database } from "@great-minds/database";
import { sql } from "drizzle-orm";
import { Cause, Effect, Layer } from "effect";

import { dieDatabase } from "./db-defects.ts";

// Frozen Alembic head; update only as part of docs/ts-migration-m5.md M5.4.
export const EXPECTED_ALEMBIC_REVISION = "0007";

export const schemaHeadMismatchMessage = (actual: string | null) =>
  `Database schema revision mismatch: expected alembic head ${EXPECTED_ALEMBIC_REVISION}, found ${actual ?? "<missing>"}`;

const schemaHeadReadMessage = `Database schema head assertion failed: could not read alembic_version.version_num; expected ${EXPECTED_ALEMBIC_REVISION}`;

export const assertSchemaHead = Effect.gen(function* () {
  const db = yield* Database;
  const result = yield* db
    .execute(sql<{ version_num: string }>`select version_num from alembic_version`)
    .pipe(
      dieDatabase,
      Effect.catchCause((cause) =>
        Effect.die(new Error(schemaHeadReadMessage, { cause: Cause.squash(cause) })),
      ),
    );
  const rows = (
    result as unknown as {
      readonly rows: readonly { readonly version_num: string }[];
    }
  ).rows;
  const actual = rows[0]?.version_num ?? null;
  if (actual !== EXPECTED_ALEMBIC_REVISION) {
    return yield* Effect.die(new Error(schemaHeadMismatchMessage(actual)));
  }
});

export const SchemaHeadLive = Layer.effectDiscard(assertSchemaHead);
